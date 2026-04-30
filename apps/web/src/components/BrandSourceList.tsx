interface Props {
  files: { file: File }[];
  onRemove: (idx: number) => void;
}

export function BrandSourceList({ files, onRemove }: Props) {
  if (files.length === 0) return null;
  return (
    <ul className="source-list">
      {files.map((s, i) => (
        <li key={`${s.file.name}-${i}`}>
          <span>
            {s.file.name} <small>({Math.round(s.file.size / 1024)} KB)</small>
          </span>
          <button type="button" onClick={() => onRemove(i)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
