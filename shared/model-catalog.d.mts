export interface CatalogSettings { provider: string; endpoint: string; apiKey?: string }
export function catalogSettings(input: { provider?: unknown; endpoint?: unknown; apiKey?: unknown }, saved?: CatalogSettings): CatalogSettings & { apiKey: string };
export function fetchModelCatalog(input: CatalogSettings, fetcher?: typeof fetch): Promise<{ models: string[]; hasMore: boolean }>;
