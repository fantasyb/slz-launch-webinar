# Deploying Cairn

The canonical origin is **https://cairny.io**. It is set in `cairn.config.json`
and can be overridden per-environment with `CAIRN_BASE_URL`.

That value is load-bearing, not cosmetic. `/api/block` signs the install block
over the canonical origin and **refuses to sign anything else** — a request
arriving under a different `Host` is served the canonical base, unsigned, with
a warning saying why. See cairn-0024 for the attack that made this necessary:
before it, `curl -H 'Host: evil.example'` returned a validly signed install
block whose every URL pointed at the attacker.

## 1. DNS

Point `cairny.io` at the host. Nothing else in this repo depends on the
registrar or the DNS provider.

## 2. Environment

| Variable | Required | Purpose |
|---|---|---|
| `CAIRN_BASE_URL` | recommended | Canonical origin. Overrides `cairn.config.json`. Must match the `Host` the site is served under, or nothing gets signed. |
| `CAIRN_SIGNING_KEY` | for signed installs | The **PEM private key**, inline. Without it the block is served unsigned and a client that pinned a key refuses it. |
| `ANTHROPIC_API_KEY` etc. | for CI review only | Never needed by the web app. |

`CAIRN_SIGNING_KEY` matters because `.cairn-secrets/` is gitignored, as a
private key must be — so on a real deployment the key cannot come from the
filesystem. It is read from the environment first and the local file is only a
development convenience.

```bash
CAIRN_SIGNING_KEY="$(cat .cairn-secrets/56f7a413738936bd.key)"
```

Set it as a secret in the host's dashboard. Do not commit it; the pre-commit
hook blocks anything under `.cairn-secrets/` precisely to stop that.

## 3. Build and run

```bash
npm ci
npm run build
npm start
```

Nothing is prerendered that depends on time — every page that computes a
decaying score declares `force-dynamic`. See cairn-0005 for why that matters.

## 4. Verify the deployment

```bash
# The block must be signed, and its base must be the canonical origin.
curl -s https://cairny.io/api/block | jq '{base, signed: (.signature != null)}'

# A forged Host must NOT be signed.
curl -s -H 'Host: evil.example' https://cairny.io/api/block \
  | jq '{base, signed: (.signature != null)}'
```

Expected: the first is `{"base": "https://cairny.io", "signed": true}`, the
second is `signed: false` with the base still `https://cairny.io`. If the first
comes back unsigned, `CAIRN_SIGNING_KEY` is not set. If the second comes back
signed, stop and do not publish — the origin binding is broken.

## 5. Publish the fingerprint somewhere else

```
fingerprint 56f7a413738936bd574cb68cb5855db902e35f8c5f83a137133a99f4a0fae5c0
```

Put it anywhere people learn about the corpus — a README, a post, a profile —
**and never only on cairny.io itself.** An adopter who copies the fingerprint
from the same host that serves the key has verified nothing; they have asked
the host whether to trust the host. That circularity is the whole reason the
pin has to travel out of band.

## 6. What adopters run

```bash
npm run cairn:install -- --into . \
  --from https://cairny.io/api/block \
  --key 56f7a413738936bd574cb68cb5855db902e35f8c5f83a137133a99f4a0fae5c0 \
  --yes
```

`--key` takes the fingerprint from step 5, obtained anywhere but the host. With
it, a compromised or impersonated host produces a signature failure instead of
silent code execution.
