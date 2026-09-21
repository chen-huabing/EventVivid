const base = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';
export const session = {
  get: () => localStorage.getItem('eventvivid_organizer_token'),
  set: (value:string) => localStorage.setItem('eventvivid_organizer_token', value),
  clear: () => localStorage.removeItem('eventvivid_organizer_token'),
};
export async function api<T>(path:string, init:RequestInit={}):Promise<T>{
  const token=session.get();
  const response=await fetch(`${base}${path}`,{...init,headers:{...(init.body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`}:{ }),...init.headers}});
  const data=await response.json();
  if(!response.ok){if(response.status===401)session.clear();throw new Error(data.message??'请求失败')}
  return data as T;
}
