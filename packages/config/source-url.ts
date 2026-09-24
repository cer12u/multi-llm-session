import { ensure } from '../contracts/index.js';
/** The exact configured endpoint is the allowlist. Redirects are not followed. */
export function validateFeedUrl(value:string):void {
  const url=new URL(value),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  ensure(!url.username&&!url.password&&!url.search&&!url.hash,422,'UNSAFE_FEED_URL');
  ensure(url.protocol==='https:'||(local&&url.protocol==='http:'),422,'FEED_HTTPS_REQUIRED');
}
