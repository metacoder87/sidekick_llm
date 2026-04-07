import { compactBytes } from '../lib/format';

export default function ModelSelect({
  models,
  activeModel,
  onChange,
  disabled,
}) {
  return (
    <label className="model-select">
      <span>Model</span>
      <select
        value={activeModel}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || models.length === 0}
      >
        {models.length === 0 ? (
          <option value="">No models available</option>
        ) : null}
        {models.map((model) => (
          <option key={model.name} value={model.name}>
            {model.name}
            {model.size ? ` • ${compactBytes(model.size)}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
