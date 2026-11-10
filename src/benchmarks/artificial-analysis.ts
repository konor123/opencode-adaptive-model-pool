// Artificial Analysis Data API v2, free tier (verified 2026-11-10: 200 items/page, 100 requests / 24h).
// Fixed URL, no redirects, timeout; the key is never part of an error message.

export const AA_FREE_URL = "https://artificialanalysis.ai/api/v2/language/models/free"

export interface AaModel {
  slug: string
  name: string
  creator?: string
  releaseDate?: string
  intelligenceIndex?: number
  codingIndex?: number
  agenticIndex?: number
  medianTps?: number
  medianTtftS?: number
  medianTtfaS?: number
  medianE2eS?: number
}

export interface AaFetchResult {
  models: AaModel[]
  pages: number
  indexVersion?: number
  rateLimitRemaining?: number
}

export class AaFetchError extends Error {
  retryAfterS?: number
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const headerNum = (h: Headers, k: string) => {
  const v = h.get(k)
  const n = v === null ? NaN : Number(v)
  return Number.isFinite(n) ? n : undefined
}

export async function fetchAaModels(
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxPages?: number } = {},
): Promise<AaFetchResult> {
  const f = opts.fetchImpl ?? fetch
  const maxPages = opts.maxPages ?? 8
  const models: AaModel[] = []
  let indexVersion: number | undefined
  let rateLimitRemaining: number | undefined
  let pages = 0
  for (let page = 1; page <= maxPages; page++) {
    let res: Response
    try {
      res = await f(`${AA_FREE_URL}?page=${page}`, {
        headers: { "x-api-key": apiKey, Accept: "application/json", "User-Agent": "oamp/0.1" },
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
      })
    } catch (e: any) {
      throw new AaFetchError(`aa fetch failed: ${e?.name ?? "Error"}`)
    }
    pages++
    rateLimitRemaining = headerNum(res.headers, "x-ratelimit-remaining") ?? rateLimitRemaining
    if (res.status >= 300 && res.status < 400) throw new AaFetchError(`aa: redirect refused (HTTP ${res.status})`)
    if (res.status === 429) {
      const err = new AaFetchError("aa: rate limited (HTTP 429)")
      err.retryAfterS = headerNum(res.headers, "retry-after")
      throw err
    }
    if (!res.ok) throw new AaFetchError(`aa: HTTP ${res.status}`)
    let body: any
    try {
      body = await res.json()
    } catch {
      throw new AaFetchError("aa: invalid JSON")
    }
    if (page === 1) indexVersion = num(body?.intelligence_index_version)
    for (const it of Array.isArray(body?.data) ? body.data : []) {
      if (typeof it?.slug !== "string" || !it.slug) continue
      const ev = it.evaluations ?? {}
      const pf = it.performance ?? {}
      models.push({
        slug: it.slug,
        name: typeof it.name === "string" ? it.name : it.slug,
        creator: typeof it.model_creator?.name === "string" ? it.model_creator.name : undefined,
        releaseDate: typeof it.release_date === "string" ? it.release_date : undefined,
        intelligenceIndex: num(ev.artificial_analysis_intelligence_index),
        codingIndex: num(ev.artificial_analysis_coding_index),
        agenticIndex: num(ev.artificial_analysis_agentic_index),
        medianTps: num(pf.median_output_tokens_per_second),
        medianTtftS: num(pf.median_time_to_first_token_seconds),
        medianTtfaS: num(pf.median_time_to_first_answer_token_seconds),
        medianE2eS: num(pf.median_end_to_end_response_time_seconds),
      })
    }
    if (!body?.pagination?.has_more) break
  }
  return { models, pages, indexVersion, rateLimitRemaining }
}
