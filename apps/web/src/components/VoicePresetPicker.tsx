import { Link } from 'react-router-dom';
import type { VoiceProfileInfo, TtsEngineInfo } from '../lib/api.js';

export function VoicePresetPicker({
  profiles,
  engines,
  engine,
  voice,
  speed,
  onChange,
  disabled = false,
}: {
  profiles: VoiceProfileInfo[];
  engines: TtsEngineInfo[];
  engine: string;
  voice: string;
  speed: number;
  onChange: (preset: VoiceProfileInfo) => void;
  disabled?: boolean;
}) {
  const match = profiles.find(
    (p) => p.engine === engine && p.voice === voice && Math.abs(p.speed - speed) < 0.01,
  );
  const selectedEngine = engines.find((e) => e.id === engine);
  return (
    <div className="voice-preset-picker">
      <label>
        Voice preset{' '}
        <select
          aria-label="Voice preset"
          disabled={disabled}
          value={match?.id ?? ''}
          onChange={(event) => {
            const preset = profiles.find((p) => p.id === event.target.value);
            if (preset) onChange(preset);
          }}
        >
          <option value="">Custom voice settings</option>
          {profiles.map((p) => (
            <option
              key={p.id}
              value={p.id}
              disabled={
                !engines.some((e) => e.id === p.engine && e.voices.some((v) => v.id === p.voice))
              }
            >
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        Selected:{' '}
        <strong>
          {selectedEngine?.voices.find((v) => v.id === voice)?.name ?? voice ?? 'Choose a voice'}
        </strong>{' '}
        · {selectedEngine?.displayName ?? engine} · {speed}× speed
      </p>
      <Link to="/settings">Manage voice presets</Link> ·{' '}
      <Link to="/voices">Voice library & previews</Link>
    </div>
  );
}
