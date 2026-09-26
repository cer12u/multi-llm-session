import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {createBrotliDecompress,createGunzip,createInflate} from 'node:zlib';

/** Model-only transport for explicitly long calls. The Worker's abort signal covers
 * headers AND body; a short connection deadline is independent of inference time.
 * No redirect following, retry, global dispatcher change or TLS relaxation. */
export const longRequestFetch:typeof fetch=async(input,init)=>{
  if(!(typeof input==='string'||input instanceof URL)||init?.method!=='POST'||typeof init.body!=='string'||!init.signal||init.redirect!=='error')
    throw new TypeError('INVALID_LONG_MODEL_REQUEST');
  const url=new URL(input);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new TypeError('INVALID_MODEL_URL');
  const signal=AbortSignal.any([init.signal,AbortSignal.timeout(910000)]);
  const headers=new Headers(init.headers);headers.set('accept-encoding','identity');
  headers.set('content-length',String(Buffer.byteLength(init.body)));
  return new Promise<Response>((resolve,reject)=>{
    const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
      method:'POST',headers:Object.fromEntries(headers.entries()),signal,agent:false,
    },response=>{
      clearTimeout(connectTimer);
      const status=response.statusCode??500;
      if(status>=300&&status<400){response.destroy();reject(new TypeError('MODEL_REDIRECT_REJECTED'));return;}
      const responseHeaders=new Headers();
      for(const [name,value] of Object.entries(response.headers))if(value!==undefined)
        for(const item of Array.isArray(value)?value:[String(value)])responseHeaders.append(name,item);
      // Accept identity by default, but preserve standard fetch decoding if a
      // server sends compression anyway. HttpModel retains its decoded byte cap.
      const encoding=responseHeaders.get('content-encoding')?.toLowerCase();
      const decoder=encoding==='gzip'?createGunzip():encoding==='deflate'?createInflate():encoding==='br'?createBrotliDecompress():null;
      if(encoding&&encoding!=='identity'&&!decoder){response.destroy();reject(new TypeError('UNSUPPORTED_MODEL_ENCODING'));return;}
      let stream:Readable=response;
      if(decoder){
        response.on('error',error=>decoder.destroy(error));decoder.on('close',()=>response.destroy());
        stream=response.pipe(decoder);responseHeaders.delete('content-encoding');responseHeaders.delete('content-length');
      }
      if([204,205,304].includes(status)){response.resume();resolve(new Response(null,{status,headers:responseHeaders}));return;}
      resolve(new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status,headers:responseHeaders}));
    });
    const connectTimer=setTimeout(()=>request.destroy(new Error('MODEL_CONNECT_TIMEOUT')),15000);
    connectTimer.unref();
    request.once('socket',socket=>{
      const event=url.protocol==='https:'?'secureConnect':'connect';
      if(!socket.connecting&&url.protocol==='http:')clearTimeout(connectTimer);
      else socket.once(event,()=>clearTimeout(connectTimer));
    });
    request.once('error',error=>{clearTimeout(connectTimer);reject(error);});
    request.once('close',()=>clearTimeout(connectTimer));
    request.end(init.body);
  });
};
