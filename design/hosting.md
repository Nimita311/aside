# Hosting

This design covers daemon-backed webapp and MCP hosting.

## Boundary and threat model

- Aside trusts the host machine. HTTP binds only to loopback; local access needs
  no Aside authentication.
- Remote deployment provides a reverse proxy, authentication, and TLS. Aside
  implements no login or authentication sessions.
- Aside retains browser cross-origin protections and
  [authored-content isolation](interfaces.md#browser-boundary).

## Local and remote access

One daemon serves the same records and tools through a unified webapp and two
MCP interfaces. Sessions keep [independent selections](runtime.md#data-ownership).

| Interface | Local | Remote |
| --- | --- | --- |
| Webapp | Direct localhost access | Same app and listener through a proxy |
| MCP | Stdio or loopback Streamable HTTP | Streamable HTTP through a proxy |

Proxy support and HTTP MCP are always available on the loopback service. No
remote mode or fixed public URL is required.

HTTP MCP navigation returns public links for the client to open; it never opens
the host's browser. Local CLI/stdio navigation opens the local HTTP URL in the
host's browser.
MCP sessions hold protocol state and selections, independently of authentication.

## Sandboxed artifacts

The parent fetches indexed artifact HTML through its normal webapp connection
and displays it in a `srcdoc` iframe with `sandbox="allow-scripts"`. Aside installs
the [artifact SDK](interfaces.md#artifact-sdk) before authored scripts run and
brokers its requests through the parent, using deployment authentication
remotely. Credentials remain outside the frame; no artifact login is needed.

The bootstrap supports [inline artifact code](interfaces.md#html-authoring) while
preserving the parent app's script protections. Local and remote previews use
the same contract, without dynamic dependency bundling.

## Proxy contract

The proxy serves Aside at the public origin root and reaches its loopback HTTP
listener. The proxy must share Aside's loopback network namespace, including in
containerized deployments. Responses must stream without buffering. Upstream
headers follow this contract:

| Header | Proxy behavior | Purpose |
| --- | --- | --- |
| `Host` | Set to the loopback backend authority, e.g. `127.0.0.1:24800` | Independent DNS-rebinding protection |
| `X-Forwarded-Host` | Overwrite with the public hostname and optional port | Public links and destination hostname for origin checks |
| `X-Forwarded-Proto` | Overwrite with the public scheme: `http` or `https` | Public links and destination scheme for origin checks |
| `Origin` | Pass through unchanged when present | Preserve the browser's request source for validation |

Aside validates the actual backend `Host` before using forwarded metadata. The
proxy must replace client-supplied forwarded values, not merely pass them through.

Aside derives absolute URLs and the destination for origin checks in this order:

| Context | Origin |
| --- | --- |
| Valid forwarded header pair | Forwarded scheme and host |
| Direct HTTP request | `http://` plus `Host`, preserving hostname and port |
| Local CLI/stdio call without HTTP context | `http://localhost:<port>` |

Forwarded metadata must be a single complete, valid pair; malformed, incomplete,
or list values are rejected. Aside requires no identity headers or shared proxy
credential.

Origin checks compare scheme, hostname, and effective port. API/control and HTTP
MCP requests reject supplied `null`, malformed, or mismatched origins.
Webapp state changes require `Content-Type: application/json`; HTTP MCP requires
its protocol content types. JSON requirements and origin checks provide CSRF
protection without CSRF tokens. Aside grants no cross-origin API access through
CORS. Requests without `Origin` are allowed only if the other request checks pass,
including the JSON requirement for webapp POSTs.

Deployment authentication must work with the chosen MCP client's credentials or
OAuth flow; browser login redirects alone are insufficient. Authentication covers
all Aside routes, including build assets and artifact files.

### nginx

Inside a deployment-authenticated TLS server on the Aside host:

```nginx
proxy_set_header Host $proxy_host;
proxy_set_header X-Forwarded-Host $http_host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_http_version 1.1;
proxy_buffering off; # Deliver event streams immediately.

location / {
    proxy_pass http://127.0.0.1:24800;
}
```

`Origin` passes through unchanged. See [proxy headers](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

### Traefik

File-provider fragment, with Traefik on the Aside host. Assumes an existing
`websecure` TLS entrypoint, certificates, and `aside-auth` authentication middleware
applied to the Aside router:

```yaml
http:
  routers:
    aside:
      rule: Host(`aside.example.com`)
      entryPoints: [websecure]
      tls: {}
      middlewares: [aside-auth]
      service: aside
  services:
    aside:
      loadBalancer:
        passHostHeader: false
        servers:
          - url: http://127.0.0.1:24800
```

[`passHostHeader: false`](https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/service/#configuration-options)
uses the backend authority for `Host`; Traefik supplies the public
[forwarded headers automatically](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/headers/).
Keep the entrypoint's default [untrusted-client forwarded-header policy](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/#forwarded-headers).
