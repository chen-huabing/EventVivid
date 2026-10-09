package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	sdk "github.com/huifurepo/bspay-go-sdk/BsPaySdk"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testConfig(t *testing.T) *sdk.MerchSysConfig {
	t.Helper()
	sdk.SetLogger(quietLogger{})
	private, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(private)
	pub, _ := x509.MarshalPKIXPublicKey(&private.PublicKey)
	t.Setenv("HUIFU_RSA_PRIVATE_KEY", base64.StdEncoding.EncodeToString(pkcs8))
	t.Setenv("HUIFU_RSA_PUBLIC_KEY", base64.StdEncoding.EncodeToString(pub))
	t.Setenv("HUIFU_PROVIDER_PUBLIC_KEY", base64.StdEncoding.EncodeToString(pub))
	t.Setenv("HUIFU_PRODUCT_ID", "test")
	t.Setenv("HUIFU_SYS_ID", "test")
	c, err := config(true)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func TestSignatures(t *testing.T) {
	c := testConfig(t)
	content := `{"req_seq_id":"test","trans_amt":"99.00","trans_stat":"S"}`
	sign, err := sdk.Sign(content, c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = run(input{Action: "verify", Content: content, Signature: sign}); err != nil {
		t.Fatal(err)
	}
	if _, err = run(input{Action: "verify", Content: strings.Replace(content, "99.00", "0.01", 1), Signature: sign}); err == nil {
		t.Fatal("tampered amount accepted")
	}
	if _, err = run(input{Action: "verify", Content: content + " ", Signature: sign}); err == nil {
		t.Fatal("modified original notification accepted")
	}
	t.Setenv("HUIFU_RSA_PRIVATE_KEY", "")
	if _, err = run(input{Action: "verify", Content: content, Signature: sign}); err != nil {
		t.Fatal("verification requires private key")
	}
}
func TestMismatchedKeys(t *testing.T) {
	testConfig(t)
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	pub, _ := x509.MarshalPKIXPublicKey(&other.PublicKey)
	t.Setenv("HUIFU_PROVIDER_PUBLIC_KEY", base64.StdEncoding.EncodeToString(pub))
	if _, err := config(true); err == nil {
		t.Fatal("mismatched private key accepted")
	}
}
func TestVerifiedTransport(t *testing.T) {
	c := testConfig(t)
	data := `{"resp_code":"00000000","trans_stat":"P"}`
	signature, _ := sdk.Sign(data, c)
	for _, tc := range []struct {
		name, body string
		valid      bool
	}{
		{"valid", `{"data":` + data + `,"sign":"` + signature + `"}`, true},
		{"missing data", `{"resp_code":"00000000"}`, false},
		{"missing signature", `{"data":` + data + `}`, false},
		{"tampered", `{"data":{"resp_code":"00000000","trans_stat":"S"},"sign":"` + signature + `"}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(tc.body)) }))
			defer server.Close()
			client := &http.Client{Transport: verifiedTransport{http.DefaultTransport, c}}
			resp, err := client.Get(server.URL)
			if (err == nil) != tc.valid {
				t.Fatalf("unexpected verification result: %v", err)
			}
			if resp != nil {
				resp.Body.Close()
			}
		})
	}
}
func TestRequestUsesOfficialSDK(t *testing.T) {
	c := testConfig(t)
	var captured map[string]interface{}
	data := `{"resp_code":"00000000","trans_stat":"P"}`
	signature, _ := sdk.Sign(data, c)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&captured)
		content, _ := sdk.FormatSignSrcText(captured["data"].(map[string]interface{}))
		if ok, _ := sdk.SignVerify(captured["sign"].(string), content, c); !ok {
			t.Error("SDK request signature invalid")
		}
		w.Write([]byte(`{"data":` + data + `,"sign":"` + signature + `"}`))
	}))
	defer server.Close()
	_, err := sdk.PostRequest(server.URL, map[string]interface{}{"huifu_id": "test-merchant", "req_date": "20260930", "req_seq_id": "test-order", "trans_amt": "99.00", "trade_type": "T_JSAPI", "extend_infos": map[string]interface{}{"wx_data": `{"sub_appid":"wx-test","sub_openid":"test-user"}`}}, c)
	if err != nil {
		t.Fatal(err)
	}
	fields := captured["data"].(map[string]interface{})
	if fields["trans_amt"] != "99.00" || fields["trade_type"] != "T_JSAPI" {
		t.Fatal("invalid request fields")
	}
	if _, ok := fields["wx_data"].(string); !ok {
		t.Fatal("wx_data must be a JSON string")
	}
}
