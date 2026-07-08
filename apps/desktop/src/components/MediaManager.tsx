import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateMedia,
  getMediaModelSchema,
  getMediaStatus,
  isOpenRouterProvider,
  listMediaModels,
  listProviders,
  mediaProviders,
  supportsMediaMetadataProvider,
  type MediaGenerationResult,
  type MediaKind,
  type MediaModelInfo,
  type MediaModelSchema,
  type MediaSchemaControl,
  type ProviderInfo,
} from "../api";
import {
  DEFAULT_MEDIA_ADVANCED_INPUT,
  bestMediaResultUrl,
  controlValue,
  defaultMediaAdvanced,
  defaultMediaModel,
  inputWithSchemaControls,
  mediaPreferenceKey,
  parseControlValue,
  schemaDefaults,
  shouldPollMediaStatus,
  isTerminalMediaStatus,
} from "../lib/media";
import { useSettings } from "../settings/store";
import { ArrowRight, Image, X } from "./icons";
import { SheetDialog } from "./SheetDialog";
import { Select } from "./ui";

function modelPlaceholder(provider?: ProviderInfo | null): string {
  if (!provider) return "black-forest-labs/flux-schnell";
  if (provider.kind === "fal") return "fal-ai/flux/schnell";
  if (isOpenRouterProvider(provider)) return "google/gemini-2.5-flash-image";
  return "black-forest-labs/flux-schnell";
}

export function MediaManager({
  onClose,
  onManageProviders,
}: {
  onClose: () => void;
  onManageProviders?: () => void;
}) {
  const mediaSettings = useSettings((s) => s.media);
  const setMediaSettings = useSettings((s) => s.setMediaSettings);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const available = useMemo(() => mediaProviders(providers), [providers]);
  const [providerId, setProviderId] = useState("");
  const selectedProvider = available.find((provider) => provider.id === providerId) ?? available[0] ?? null;
  const [kind, setKind] = useState<MediaKind>("image");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [advanced, setAdvanced] = useState(DEFAULT_MEDIA_ADVANCED_INPUT);
  const [modelOptions, setModelOptions] = useState<MediaModelInfo[]>([]);
  const [modelSearch, setModelSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [modelSchema, setModelSchema] = useState<MediaModelSchema | null>(null);
  const [parameterValues, setParameterValues] = useState<Record<string, unknown>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MediaGenerationResult[]>([]);
  const pollingKeys = useRef<Set<string>>(new Set());
  const metadataImageProvider = Boolean(selectedProvider && supportsMediaMetadataProvider(selectedProvider) && kind === "image");
  const favoriteModelIds = selectedProvider ? mediaSettings.favoriteModelIdsByProvider[selectedProvider.id] ?? [] : [];
  const visibleModelOptions = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    return modelOptions
      .filter((item) => {
        if (favoritesOnly && !favoriteModelIds.includes(item.id)) return false;
        if (!query) return true;
        return (
          item.id.toLowerCase().includes(query) ||
          item.name.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query)
        );
      })
      .sort((a, b) => Number(favoriteModelIds.includes(b.id)) - Number(favoriteModelIds.includes(a.id)));
  }, [modelOptions, modelSearch, favoritesOnly, favoriteModelIds.join("\u0000")]);
  const selectedModelFavorite = Boolean(model && favoriteModelIds.includes(model));

  useEffect(() => {
    listProviders().then((next) => {
      const media = mediaProviders(next);
      const saved = useSettings.getState().media;
      const initialProvider = media.find((provider) => provider.id === saved.providerId) ?? media[0];
      const initialModel = initialProvider
        ? saved.modelByProvider[initialProvider.id] || defaultMediaModel(initialProvider)
        : "";
      const key = initialProvider ? mediaPreferenceKey(initialProvider.id, initialModel) : "";
      setProviders(next);
      setProviderId((current) => current || initialProvider?.id || "");
      setModel((current) => current || initialModel);
      setAdvanced((current) => current === DEFAULT_MEDIA_ADVANCED_INPUT && key
        ? saved.advancedByProviderModel[key] ?? defaultMediaAdvanced(initialProvider)
        : current);
      setParameterValues(key ? saved.parametersByProviderModel[key] ?? {} : {});
      if (initialProvider) setModelSearch(saved.modelSearchByProvider[initialProvider.id] ?? "");
    });
  }, []);

  useEffect(() => {
    if (!selectedProvider) return;
    setProviderId(selectedProvider.id);
    setMediaSettings({ providerId: selectedProvider.id });
    setModel((current) => current || mediaSettings.modelByProvider[selectedProvider.id] || defaultMediaModel(selectedProvider));
  }, [selectedProvider]);

  useEffect(() => {
    if (!selectedProvider || !metadataImageProvider) {
      setModelOptions([]);
      setModelSchema(null);
      setModelsLoading(false);
      setSchemaLoading(false);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setError(null);
    listMediaModels(selectedProvider.id, "image", { query: modelSearch })
      .then((models) => {
        if (cancelled) return;
        setModelOptions(models);
        const savedModel = useSettings.getState().media.modelByProvider[selectedProvider.id];
        const nextModel = savedModel && models.some((item) => item.id === savedModel)
          ? savedModel
          : model && models.some((item) => item.id === model)
            ? model
            : models[0]?.id || defaultMediaModel(selectedProvider);
        if (nextModel && nextModel !== model) {
          applyModel(nextModel, selectedProvider);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider?.id, metadataImageProvider, modelSearch]);

  useEffect(() => {
    if (!selectedProvider || !metadataImageProvider || !model.trim()) {
      setModelSchema(null);
      return;
    }
    let cancelled = false;
    const key = mediaPreferenceKey(selectedProvider.id, model.trim());
    setSchemaLoading(true);
    getMediaModelSchema(selectedProvider.id, model.trim())
      .then((schema) => {
        if (cancelled) return;
        setModelSchema(schema);
        const saved = useSettings.getState().media.parametersByProviderModel[key];
        setParameterValues({ ...schemaDefaults(schema), ...saved });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setSchemaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProvider?.id, metadataImageProvider, model]);

  function applyModel(nextModel: string, provider = selectedProvider) {
    setModel(nextModel);
    if (!provider) return;
    const key = mediaPreferenceKey(provider.id, nextModel);
    const saved = useSettings.getState().media;
    setAdvanced(saved.advancedByProviderModel[key] ?? defaultMediaAdvanced(provider));
    setParameterValues(saved.parametersByProviderModel[key] ?? {});
    setMediaSettings({
      providerId: provider.id,
      modelByProvider: {
        ...saved.modelByProvider,
        [provider.id]: nextModel,
      },
    });
  }

  function applyProvider(id: string) {
    const provider = available.find((item) => item.id === id);
    setProviderId(id);
    if (!provider) return;
    const saved = useSettings.getState().media;
    const nextModel = saved.modelByProvider[id] || defaultMediaModel(provider);
    const key = mediaPreferenceKey(id, nextModel);
    setModel(nextModel);
    setAdvanced(saved.advancedByProviderModel[key] ?? defaultMediaAdvanced(provider));
    setParameterValues(saved.parametersByProviderModel[key] ?? {});
    setModelSearch(saved.modelSearchByProvider[id] ?? "");
    setMediaSettings({ providerId: id });
  }

  function updateModelSearch(value: string) {
    setModelSearch(value);
    if (!selectedProvider) return;
    const saved = useSettings.getState().media;
    setMediaSettings({
      modelSearchByProvider: {
        ...saved.modelSearchByProvider,
        [selectedProvider.id]: value,
      },
    });
  }

  function toggleSelectedFavorite() {
    if (!selectedProvider || !model.trim()) return;
    const saved = useSettings.getState().media;
    const current = saved.favoriteModelIdsByProvider[selectedProvider.id] ?? [];
    const next = current.includes(model)
      ? current.filter((item) => item !== model)
      : [...current, model];
    setMediaSettings({
      favoriteModelIdsByProvider: {
        ...saved.favoriteModelIdsByProvider,
        [selectedProvider.id]: next,
      },
    });
  }

  async function refreshMediaMetadata() {
    if (!selectedProvider || !metadataImageProvider) return;
    setModelsLoading(true);
    setSchemaLoading(true);
    setError(null);
    try {
      const [models, schema] = await Promise.all([
        listMediaModels(selectedProvider.id, "image", { query: modelSearch, refresh: true }),
        model.trim()
          ? getMediaModelSchema(selectedProvider.id, model.trim(), { refresh: true })
          : Promise.resolve(null),
      ]);
      setModelOptions(models);
      if (schema) {
        setModelSchema(schema);
        const key = mediaPreferenceKey(selectedProvider.id, model.trim());
        const saved = useSettings.getState().media.parametersByProviderModel[key];
        setParameterValues({ ...schemaDefaults(schema), ...saved });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setModelsLoading(false);
      setSchemaLoading(false);
    }
  }

  function updateAdvanced(value: string) {
    setAdvanced(value);
    if (!selectedProvider || !model.trim()) return;
    const key = mediaPreferenceKey(selectedProvider.id, model.trim());
    const saved = useSettings.getState().media;
    setMediaSettings({
      advancedByProviderModel: {
        ...saved.advancedByProviderModel,
        [key]: value,
      },
    });
  }

  function updateParameter(control: MediaSchemaControl, value: string | boolean) {
    if (!selectedProvider || !model.trim()) return;
    let parsed: unknown;
    try {
      parsed = parseControlValue(control, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const next = { ...parameterValues, [control.key]: parsed };
    setParameterValues(next);
    const key = mediaPreferenceKey(selectedProvider.id, model.trim());
    const saved = useSettings.getState().media;
    setMediaSettings({
      parametersByProviderModel: {
        ...saved.parametersByProviderModel,
        [key]: next,
      },
    });
  }

  async function pollMediaStatus(initial: MediaGenerationResult) {
    const key = `${initial.provider_id}:${initial.id}`;
    if (pollingKeys.current.has(key) || !shouldPollMediaStatus(initial)) return;
    pollingKeys.current.add(key);
    let current = initial;
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const next = await getMediaStatus({
          provider_id: current.provider_id,
          id: current.id,
          model: current.model,
          response_url: current.urls.response,
          status_url: current.urls.status,
        });
        current = next;
        setResults((items) => items.map((item) => (
          item.provider_id === next.provider_id && item.id === next.id ? { ...item, ...next } : item
        )));
        if (isTerminalMediaStatus(next.status) || next.media.length > 0) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      pollingKeys.current.delete(key);
    }
  }

  async function submit() {
    const provider = selectedProvider;
    if (!provider) {
      setError("Add an enabled Replicate, fal, or OpenRouter provider first.");
      return;
    }
    if (!model.trim()) {
      setError("Model id is required.");
      return;
    }
    if (!prompt.trim()) {
      setError("Prompt is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await generateMedia({
        provider_id: provider.id,
        kind,
        model: model.trim(),
        prompt: prompt.trim(),
        input: inputWithSchemaControls(advanced, metadataImageProvider ? modelSchema : null, parameterValues),
      });
      setResults((current) => [result, ...current].slice(0, 8));
      void pollMediaStatus(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openResult(result: MediaGenerationResult) {
    const url = bestMediaResultUrl(result);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <SheetDialog title="Generate media" className="sheet media-sheet" testId="media-generator" onClose={onClose}>
        <div className="sheet-header">
          <h2>Generate media</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </div>
        <p className="sheet-sub">Use encrypted Replicate, fal, or OpenRouter credentials for image and video runs.</p>

        <div className="media-grid">
          <section className="media-form">
            <label className="field">
              <span>Provider</span>
              <Select
                value={selectedProvider?.id ?? ""}
                testId="media-provider-select"
                placeholder="Choose a media provider..."
                options={available.map((provider) => ({
                  label: `${provider.name} (${provider.kind})`,
                  value: provider.id,
                }))}
                onChange={applyProvider}
              />
            </label>

            <div className="media-kind-tabs" data-testid="media-kind-tabs">
              {(["image", "video"] as MediaKind[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={kind === item ? "active" : ""}
                  onClick={() => setKind(item)}
                >
                  {item}
                </button>
              ))}
            </div>

            <label className="field">
              <span>Model id</span>
              {metadataImageProvider && (
                <div className="media-model-tools">
                  <input
                    className="css-input"
                    data-testid="media-model-search"
                    value={modelSearch}
                    placeholder="Search image models..."
                    onChange={(e) => updateModelSearch(e.target.value)}
                  />
                  <button
                    className="btn-ghost"
                    data-testid="media-model-refresh"
                    type="button"
                    onClick={() => void refreshMediaMetadata()}
                    disabled={modelsLoading || schemaLoading}
                  >
                    Refresh
                  </button>
                  <button
                    className="btn-ghost"
                    data-testid="media-model-favorite"
                    type="button"
                    onClick={toggleSelectedFavorite}
                    disabled={!model.trim()}
                  >
                    {selectedModelFavorite ? "Unfavorite" : "Favorite"}
                  </button>
                  <label className="tool-check" title="Only show favorited image models">
                    <input
                      data-testid="media-model-favorites-only"
                      type="checkbox"
                      checked={favoritesOnly}
                      onChange={(e) => setFavoritesOnly(e.target.checked)}
                    />
                    Favorites
                  </label>
                </div>
              )}
              {metadataImageProvider ? (
                <Select
                  value={model}
                  testId="media-model-select"
                  placeholder={modelsLoading ? "Loading image models..." : "Choose an image model..."}
                  options={visibleModelOptions.map((item) => ({
                    label: `${favoriteModelIds.includes(item.id) ? "* " : ""}${item.name ? `${item.name} (${item.id})` : item.id}`,
                    value: item.id,
                  }))}
                  onChange={(id) => applyModel(id)}
                />
              ) : (
                <input
                  className="css-input"
                  data-testid="media-model-input"
                  value={model}
                  placeholder={modelPlaceholder(selectedProvider)}
                  onChange={(e) => applyModel(e.target.value)}
                />
              )}
            </label>

            <label className="field">
              <span>Prompt</span>
              <textarea
                className="css-input media-prompt"
                data-testid="media-prompt-input"
                value={prompt}
                placeholder="Product photo on a clean workbench, natural side light..."
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>

            {metadataImageProvider && (
              <div className="media-parameter-controls" data-testid="media-parameter-controls">
                {schemaLoading ? (
                  <span className="sheet-hint">Loading model parameters...</span>
                ) : (
                  modelSchema?.controls.map((control) => (
                    <label className="field" key={control.key}>
                      <span title={control.description}>{control.label}</span>
                      {control.kind === "select" ? (
                        <select
                          className="css-input"
                          data-testid={`media-param-${control.key}`}
                          value={controlValue(parameterValues[control.key])}
                          onChange={(e) => updateParameter(control, e.target.value)}
                        >
                          {(control.options ?? []).map((option) => (
                            <option key={String(option.value)} value={String(option.value)}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : control.kind === "checkbox" ? (
                        <input
                          className="media-checkbox-input"
                          data-testid={`media-param-${control.key}`}
                          type="checkbox"
                          checked={Boolean(parameterValues[control.key])}
                          onChange={(e) => updateParameter(control, e.target.checked)}
                        />
                      ) : control.kind === "array" ? (
                        <textarea
                          className="css-input"
                          data-testid={`media-param-${control.key}`}
                          placeholder={control.placeholder}
                          value={controlValue(parameterValues[control.key])}
                          onChange={(e) => updateParameter(control, e.target.value)}
                        />
                      ) : control.kind === "json" ? (
                        <textarea
                          className="css-input"
                          data-testid={`media-param-${control.key}`}
                          placeholder={control.placeholder}
                          value={controlValue(parameterValues[control.key])}
                          onChange={(e) => updateParameter(control, e.target.value)}
                        />
                      ) : (
                        <input
                          className="css-input"
                          data-testid={`media-param-${control.key}`}
                          type={control.kind === "url" ? "url" : control.kind === "text" ? "text" : "number"}
                          placeholder={control.placeholder}
                          min={control.min}
                          max={control.max}
                          step={control.step}
                          value={controlValue(parameterValues[control.key])}
                          onChange={(e) => updateParameter(control, e.target.value)}
                        />
                      )}
                    </label>
                  ))
                )}
              </div>
            )}

            <label className="field">
              <span>Advanced input <em>JSON object</em></span>
              <textarea
                className="css-input media-advanced"
                value={advanced}
                spellCheck={false}
                onChange={(e) => updateAdvanced(e.target.value)}
              />
            </label>

            <div className="media-actions">
              {available.length === 0 && onManageProviders && (
                <button className="btn-ghost" type="button" onClick={onManageProviders}>
                  Providers
                </button>
              )}
              <button className="btn-accent" data-testid="media-generate" type="button" disabled={busy} onClick={() => void submit()}>
                {busy ? "Generating..." : "Generate"}
              </button>
            </div>

            <div className="media-privacy" data-testid="media-privacy">
              Remote media prompts use the active privacy gate. Redact replaces detected PII before upload; Block refuses the request.
            </div>
            {error && <div className="artifact-error">{error}</div>}
          </section>

          <section className="media-results">
            {results.length === 0 ? (
              <div className="media-empty">
                <Image size={24} />
                <span>No media runs yet.</span>
              </div>
            ) : (
              results.map((result) => {
                const url = bestMediaResultUrl(result);
                return (
                  <article className="media-result" data-testid="media-result" key={`${result.provider_id}-${result.id}-${result.status}`}>
                    <div className="media-result-preview" data-testid="media-result-preview">
                      {result.media[0]?.kind === "video" && result.media[0]?.url ? (
                        <video src={result.media[0].url} controls />
                      ) : result.media[0]?.url ? (
                        <img src={result.media[0].url} alt={`Generated media from ${result.model}`} />
                      ) : (
                        <Image size={26} />
                      )}
                    </div>
                    <div className="media-result-body">
                      <strong>{result.model}</strong>
                      <span>
                        {result.provider} - {result.status}
                        {result.privacy.redacted ? " - redacted" : ""}
                      </span>
                      {url && (
                        <button data-testid="media-result-open" className="btn-ghost" type="button" onClick={() => openResult(result)}>
                          Open <ArrowRight size={13} />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })
            )}
          </section>
        </div>
      </SheetDialog>
  );
}

export default MediaManager;
