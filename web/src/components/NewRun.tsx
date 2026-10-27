import { useEffect, useState, type FormEvent } from "react";
import type { Connection, CreateRunRequest, Skill } from "../api";

interface Props {
  skills: Skill[];
  connections: Connection[];
  onStart: (request: CreateRunRequest) => Promise<void>;
}

type Mode = "skill" | "ask";
type InputValues = Record<string, string | number | boolean>;

const EXAMPLES = [
  "Summarise #eng-standup into Notion",
  "Post the action items from the postmortem to #incidents",
  "What happened in #incidents?",
];

const defaultsFor = (skill: Skill | undefined): InputValues =>
  Object.fromEntries((skill?.inputs ?? []).map((i) => [i.name, i.default ?? (i.type === "boolean" ? false : "")]));

export function NewRun({ skills, connections, onStart }: Props) {
  const [mode, setMode] = useState<Mode>("skill");
  const [skillId, setSkillId] = useState<string>("");
  const [inputs, setInputs] = useState<InputValues>({});
  const [prompt, setPrompt] = useState("");
  const [autoApprove, setAutoApprove] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skill = skills.find((s) => s.id === skillId);

  useEffect(() => {
    if (!skillId && skills[0]) setSkillId(skills[0].id);
  }, [skills, skillId]);
  useEffect(() => setInputs(defaultsFor(skill)), [skill]);

  const missingConnectors = (skill?.connectors ?? []).filter((id) => !connections.find((c) => c.provider === id)?.connected);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "skill" && skill) {
        await onStart({ skillId: skill.id, inputs, prompt: prompt.trim() || undefined, autoApprove });
      } else {
        await onStart({ prompt, autoApprove });
      }
      setPrompt("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = !submitting && (mode === "skill" ? Boolean(skill) : prompt.trim().length > 0);

  return (
    <section className="card new-run">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "skill"} className={`tab ${mode === "skill" ? "active" : ""}`} onClick={() => setMode("skill")}>
          Run a skill
        </button>
        <button role="tab" aria-selected={mode === "ask"} className={`tab ${mode === "ask" ? "active" : ""}`} onClick={() => setMode("ask")}>
          Ask
        </button>
      </div>

      <form onSubmit={submit}>
        {mode === "skill" ? (
          <>
            <div className="skill-grid">
              {skills.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={`skill ${s.id === skillId ? "selected" : ""}`}
                  onClick={() => setSkillId(s.id)}
                  aria-pressed={s.id === skillId}
                >
                  <span className="skill-name">{s.name}</span>
                  <span className="skill-desc">{s.description}</span>
                  <span className="skill-tools">{s.connectors.join(" + ")}</span>
                </button>
              ))}
            </div>

            {skill && (
              <div className="fields">
                {skill.inputs.map((input) => (
                  <label key={input.name} className={`field ${input.type === "boolean" ? "field-inline" : ""}`}>
                    <span className="field-label">
                      {input.label}
                      {input.required && <span className="required"> *</span>}
                    </span>
                    {input.type === "boolean" ? (
                      <input
                        type="checkbox"
                        checked={Boolean(inputs[input.name])}
                        onChange={(e) => setInputs({ ...inputs, [input.name]: e.target.checked })}
                      />
                    ) : (
                      <input
                        type={input.type === "number" ? "number" : "text"}
                        value={String(inputs[input.name] ?? "")}
                        required={input.required}
                        // Sent as typed; the server coerces numbers and applies defaults for empty fields.
                        onChange={(e) => setInputs({ ...inputs, [input.name]: e.target.value })}
                      />
                    )}
                    {input.description && <span className="field-hint">{input.description}</span>}
                  </label>
                ))}
                <label className="field field-wide">
                  <span className="field-label">Extra instructions (optional)</span>
                  <input type="text" value={prompt} placeholder="e.g. keep it under 10 bullets" onChange={(e) => setPrompt(e.target.value)} />
                </label>
              </div>
            )}
            {missingConnectors.length > 0 && (
              <p className="warning small">
                This skill uses {missingConnectors.join(" and ")}, which is not connected. The run will still start; watch how the agent handles the
                error.
              </p>
            )}
          </>
        ) : (
          <>
            <textarea
              className="prompt"
              rows={3}
              value={prompt}
              placeholder="What should Relay do? e.g. Summarise yesterday's #eng-standup into the Standup Notes page"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit) void submit(e);
              }}
            />
            <div className="examples">
              {EXAMPLES.map((example) => (
                <button type="button" key={example} className="chip" onClick={() => setPrompt(example)}>
                  {example}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="form-footer">
          <label className="checkbox">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
            <span>Run write actions without asking</span>
          </label>
          <button className="button button-primary" type="submit" disabled={!canSubmit}>
            {submitting ? "Starting…" : "Start run"}
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
      </form>
    </section>
  );
}
