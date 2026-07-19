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

---

## 4. Anonymous access policy (SEC-L #46)

The bucket's anonymous policy must be **GetObject-only** — never `mc anonymous
set download`, which additionally grants `s3:ListBucket` and lets anyone
enumerate every media key. Clients render `PUBLIC_MEDIA_URL/<key>` directly, so
anonymous object read is required; listing is not. Keys are
`<entity>/<uuid>/<random-uuid>.jpg`, so with listing disabled a client must
already hold the exact (unguessable) key — and those live only in the synced,
auth-gated `media` table.

The compose `minio-init` service now applies this automatically. To (re)apply it
by hand on prod — e.g. after wiping the MinIO volume:

```bash
ssh root@<UNRAID-IP> 'docker exec inventorypro-minio-1 sh -c "
  mc alias set local http://localhost:9000 \$MINIO_ROOT_USER \$MINIO_ROOT_PASSWORD
  printf %s \"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"AWS\\\":[\\\"*\\\"]},\\\"Action\\\":[\\\"s3:GetObject\\\"],\\\"Resource\\\":[\\\"arn:aws:s3:::inventorypro-media/*\\\"]}]}\" > /tmp/anon.json
  mc anonymous set-json /tmp/anon.json local/inventorypro-media"'
```

Verify: a known object still returns `200`, but bucket listing returns
`AccessDenied`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://s3.invenpro.app/inventorypro-media/<known/key>.jpg"  # 200
curl -s "https://s3.invenpro.app/inventorypro-media/?list-type=2" | head -c 80                          # AccessDenied
```

> Applied to prod 2026-07-19 (was `download`/ListBucket — now GetObject-only).
