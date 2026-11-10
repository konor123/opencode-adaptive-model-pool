// Provider /v1/models fetchers for config-defined providers (replaces tools/sync-xkiro-models.py).
// Safety: fixed HTTPS endpoints only, no redirects, timeout, credentials never logged or stored.
import type { ProviderSyncSpec } from "../options.ts"
import type { CatalogModel } from "../types.ts"

export const PROVIDER_ENDPOINTS: Record<string, string> = {
  xkiro: "https://api.xkiro.com/v1/models",
  exaone: "https://api.exaone.ai/v1/models",
}

export class ProviderFetchError extends Error {}

const redact = (s: string, secret?: string) =>
  (secret ? s.split(secret).join("[REDACTED]") : s).replace(/(?:sk-[A-Za-z0-9_.-]+|bearer\s+\S+)/gi, "[REDACTED]")

export async function fetchProviderModels(
  providerID: string,
  apiKey: string | undefined,
  spec: ProviderSyncSpec,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CatalogModel[]> {
  const url = PROVIDER_ENDPOINTS[providerID]
  if (!url) throw new ProviderFetchError(`no fixed endpoint for provider ${providerID}`)
  const f = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "oamp/0.1" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  let res: Response
  try {
    res = await f(url, { headers, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) })
  } catch (e: any) {
    throw new ProviderFetchError(redact(`${providerID} models fetch failed: ${e?.name ?? "Error"}`, apiKey))
  }
  if (res.status >= 300 && res.status < 400) throw new ProviderFetchError(`${providerID} models: redirect refused (HTTP ${res.status})`)
  if (!res.ok) throw new ProviderFetchError(`${providerID} models: HTTP ${res.status}`)
  let body: any
  try {
    body = await res.json()
  } catch {
    throw new ProviderFetchError(`${providerID} models: invalid JSON`)
  }
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  const out: CatalogModel[] = []
  for (const r of rows) {
    const id = r?.id
    if (typeof id !== "string" || !id.trim() || id.length > 200) throw new ProviderFetchError(`${providerID} models: invalid model id`)
    if (spec.filter === "free-chat") {
      if (r.access_tier !== "free" || r.modality !== "chat" || r.pricing?.input !== 0 || r.pricing?.output !== 0) continue
    }
    const pricing = r?.pricing && typeof r.pricing.input === "number" && typeof r.pricing.output === "number"
      ? { input: r.pricing.input, output: r.pricing.output } : undefined
    out.push({
      providerID,
      modelID: id,
      name: typeof r.display_name === "string" ? r.display_name : id,
      cost: pricing,
      toolCall: typeof r?.capabilities?.tools === "boolean" ? r.capabilities.tools : undefined,
      reasoning: typeof r?.capabilities?.reasoning === "boolean" ? r.capabilities.reasoning : undefined,
      contextLimit: typeof r.context_length === "number" ? r.context_length : undefined,
      outputLimit: typeof r.max_output_tokens === "number" ? r.max_output_tokens : undefined,
      inputModalities: r?.capabilities?.vision ? ["text", "image"] : undefined,
      outputModalities: r.modality === "chat" ? ["text"] : undefined,
      accessTier: typeof r.access_tier === "string" ? r.access_tier : undefined,
      source: "provider-api",
    })
  }
  if (out.length === 0) throw new ProviderFetchError(`${providerID} models: empty after filter; cache retained`)
  return out
}
