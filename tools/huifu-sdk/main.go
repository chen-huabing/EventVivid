// A one-shot bridge: secrets arrive through the environment, never command-line arguments.
package main

import (
	"bytes"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	sdk "github.com/huifurepo/bspay-go-sdk/BsPaySdk"
)

type input struct {
	Action      string `json:"action"`
	ReqDate     string `json:"reqDate"`
	ReqSeqID    string `json:"reqSeqId"`
	Amount      string `json:"amount"`
	Description string `json:"description"`
	OpenID      string `json:"openid"`
	Expires     string `json:"expires"`
	Content     string `json:"content"`
	Signature   string `json:"signature"`
}

type quietLogger struct{}

func (quietLogger) Println(v ...interface{}) {}

func keyBytes(value string) ([]byte, error) {
	value = strings.ReplaceAll(value, "\\n", "\n")
	if block, _ := pem.Decode([]byte(value)); block != nil {
		return block.Bytes, nil
	}
	return base64.StdEncoding.DecodeString(strings.Join(strings.Fields(value), ""))
}

func config(signing bool) (*sdk.MerchSysConfig, error) {
	public, err := keyBytes(os.Getenv("HUIFU_RSA_PUBLIC_KEY"))
	if err != nil {
		return nil, errors.New("invalid Huifu public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(public)
	if err != nil {
		return nil, errors.New("invalid Huifu public key")
	}
	if k, ok := parsed.(*rsa.PublicKey); !ok || k.N.BitLen() < 2048 {
		return nil, errors.New("RSA public key must be at least 2048 bits")
	}
	c := &sdk.MerchSysConfig{ProductId: os.Getenv("HUIFU_PRODUCT_ID"), SysId: os.Getenv("HUIFU_SYS_ID"), RsaHuifuPublicKey: base64.StdEncoding.EncodeToString(public), SignType: sdk.SIGN_TYPE_RSA}
	if !signing {
		return c, nil
	}
	raw, err := keyBytes(os.Getenv("HUIFU_RSA_PRIVATE_KEY"))
	if err != nil {
		return nil, errors.New("invalid service provider private key")
	}
	var private *rsa.PrivateKey
	if p, e := x509.ParsePKCS8PrivateKey(raw); e == nil {
		private, _ = p.(*rsa.PrivateKey)
	} else {
		private, _ = x509.ParsePKCS1PrivateKey(raw)
	}
	if private == nil || private.N.BitLen() < 2048 {
		return nil, errors.New("invalid RSA private key")
	}
	provider, err := keyBytes(os.Getenv("HUIFU_PROVIDER_PUBLIC_KEY"))
	if err != nil {
		return nil, errors.New("invalid service provider public key")
	}
	derived, _ := x509.MarshalPKIXPublicKey(&private.PublicKey)
	if !bytes.Equal(provider, derived) {
		return nil, errors.New("private key does not match service provider public key")
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		return nil, errors.New("invalid RSA private key")
	}
	c.RsaMerchPrivateKey = base64.StdEncoding.EncodeToString(pkcs8)
	if c.IsEmpty() {
		return nil, errors.New("incomplete SDK configuration")
	}
	// SDK ignores signing errors during a request; preflight prevents an unsigned transaction.
	if _, err = sdk.Sign("preflight", c); err != nil {
		return nil, errors.New("SDK signing preflight failed")
	}
	return c, nil
}

// Harden SDK response handling: reject missing signatures/data instead of accepting
// an unsigned envelope or panicking, cap response size, and prohibit HTTP redirects.
type verifiedTransport struct {
	base   http.RoundTripper
	config *sdk.MerchSysConfig
}

func (t verifiedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, errors.New("payment network request failed")
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 128*1024+1))
	if err != nil || len(body) > 128*1024 {
		return nil, errors.New("invalid payment response")
	}
	if resp.StatusCode != 200 {
		return nil, errors.New("payment gateway HTTP error")
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(body, &envelope) != nil || len(envelope["data"]) == 0 || envelope["data"][0] != '{' {
		return nil, errors.New("missing signed payment data")
	}
	var signature string
	if json.Unmarshal(envelope["sign"], &signature) != nil || signature == "" {
		return nil, errors.New("missing payment signature")
	}
	content := string(envelope["data"])
	content = strings.NewReplacer("\\u003c", "<", "\\u003e", ">", "\\u0026", "&").Replace(content)
	if ok, e := sdk.SignVerify(signature, content, t.config); e != nil || !ok {
		return nil, errors.New("payment signature verification failed")
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, nil
}

func run(in input) (interface{}, error) {
	c, err := config(in.Action != "verify")
	if err != nil {
		return nil, err
	}
	if in.Action == "verify" {
		ok, e := sdk.SignVerify(in.Signature, in.Content, c)
		if e != nil || !ok {
			return nil, errors.New("notification signature verification failed")
		}
		return map[string]bool{"verified": true}, nil
	}
	if in.Action == "preflight" {
		return map[string]bool{"ready": true}, nil
	}
	bp := &sdk.BsPay{IsProdMode: os.Getenv("HUIFU_ENV") == "production", Msc: c}
	http.DefaultClient = &http.Client{Timeout: 12 * time.Second, Transport: verifiedTransport{http.DefaultTransport, c}, CheckRedirect: func(req *http.Request, via []*http.Request) error { return errors.New("redirect rejected") }}
	var resp map[string]interface{}
	switch in.Action {
	case "pay":
		wx, _ := json.Marshal(map[string]string{"sub_appid": os.Getenv("HUIFU_WECHAT_APP_ID"), "sub_openid": in.OpenID})
		resp, err = bp.V2TradePaymentJspayRequest(sdk.V2TradePaymentJspayRequest{ReqDate: in.ReqDate, ReqSeqId: in.ReqSeqID, HuifuId: os.Getenv("HUIFU_ID"), GoodsDesc: in.Description, TradeType: "T_JSAPI", TransAmt: in.Amount, ExtendInfos: map[string]interface{}{"wx_data": string(wx), "notify_url": os.Getenv("HUIFU_NOTIFY_URL"), "time_expire": in.Expires, "delay_acct_flag": "N"}})
	case "query":
		resp, err = bp.V2TradePaymentScanpayQueryRequest(sdk.V2TradePaymentScanpayQueryRequest{HuifuId: os.Getenv("HUIFU_ID"), OrgReqDate: in.ReqDate, OrgReqSeqId: in.ReqSeqID})
	default:
		return nil, errors.New("unsupported SDK operation")
	}
	if err != nil {
		return nil, errors.New("SDK request failed; query the order before retrying")
	}
	data, ok := resp["data"].(map[string]interface{})
	if !ok {
		return nil, errors.New("invalid SDK response data")
	}
	return data, nil
}

func main() {
	sdk.SetLogger(quietLogger{})
	// Do not emit panic values: some SDK failures can include raw gateway responses.
	defer func() {
		if recover() != nil {
			fmt.Println(`{"error":"SDK operation failed"}`)
			os.Exit(1)
		}
	}()
	var in input
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 128*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		fmt.Println(`{"error":"invalid SDK input"}`)
		os.Exit(1)
	}
	result, err := run(in)
	if err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error()})
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"data": result})
}
