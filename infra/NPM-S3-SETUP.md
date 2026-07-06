# NPM setup: `s3.invenpro.app` (MinIO media)

This makes photo/video uploads reach your prod MinIO so media works on the
standalone APK. The API is already configured to sign upload URLs for
`https://s3.invenpro.app` — this just wires NPM to forward that hostname to
MinIO. Same pattern you used for `api.invenpro.app`.

Replace `<UNRAID-IP>` with your Unraid LAN IP (e.g. `192.168.1.239`).

---

## 1. Add the Proxy Host

In **Nginx Proxy Manager → Hosts → Proxy Hosts → Add Proxy Host**:

**Details tab**
- **Domain Names:** `s3.invenpro.app`
- **Scheme:** `http`
- **Forward Hostname / IP:** `<UNRAID-IP>`
- **Forward Port:** `9000`   ← the MinIO **S3 API** port (not 9001, which is the console)
- **Block Common Exploits:** ✅
- **Websockets Support:** ✅ (harmless)

**SSL tab**
- **SSL Certificate:** "Request a new SSL Certificate"
- **Force SSL:** ✅
- **HTTP/2 Support:** ✅
- Agree to Let's Encrypt, enter your email → **Save**

(DNS for `s3.invenpro.app` must point at your public IP, same as `api.`)

---

## 2. Advanced → Custom Nginx Configuration

On the proxy host's **Advanced** tab, paste exactly this (also in `~/nginx.conf.txt`):

```nginx
client_max_body_size 100m;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
```

**Why each line matters:**
- `client_max_body_size 100m;` — without it, NPM rejects photo/video uploads over ~1 MB with `413 Request Entity Too Large`.
- `proxy_set_header Host $host;` — **critical.** MinIO presigned upload URLs are cryptographically bound to the hostname. If NPM rewrites the Host header, MinIO returns `SignatureDoesNotMatch` and every upload fails.

Save.

---

## 3. Verify

```bash
# MinIO health through NPM (expect HTTP 200)
curl -s -o /dev/null -w "%{http_code}\n" https://s3.invenpro.app/minio/health/live

# Bucket should exist (the prod stack's minio-init creates it). If 0 objects, that's fine.
# On Unraid: docker exec inventorypro-minio-1 sh -c 'mc ls local/inventorypro-media 2>/dev/null || echo "create it"'
```

If health returns 200, you're done — tell me and I'll run an end-to-end upload
smoke test against prod, then media works on your phone.

> If the `inventorypro-media` bucket doesn't exist on prod yet, I can create it
> via the `unraid` skill in one command (mirrors the dev setup).
