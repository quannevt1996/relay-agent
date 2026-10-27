interface Props {
  value: unknown;
  /** Collapsed behind a <details> toggle, with this label as the summary. */
  label?: string;
  open?: boolean;
}

export function Json({ value, label, open = false }: Props) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const block = <pre className="json">{text}</pre>;
  if (!label) return block;
  return (
    <details className="json-details" open={open}>
      <summary>{label}</summary>
      {block}
    </details>
  );
}
