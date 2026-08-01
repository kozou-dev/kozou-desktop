<script lang="ts">
  // The COMMENT editor. Raw text in, one statement out, nothing executed.
  //
  // The textarea is seeded from the VERBATIM comment, never from the rendered
  // `description`: the context builder lifts `@widget:` and `@example:` blocks
  // out of that field, so an editor seeded from it would silently delete those
  // tags the moment anything was saved. The verbatim text rides its own field
  // for exactly this reason (see shared/trim.ts).
  //
  // No structured tag editor, deliberately. `@ai:`/`@policy:` lines are part of
  // the comment body and stay there; parsing them apart and re-serializing them
  // would introduce a round trip this feature does not need and could not make
  // lossless.

  import { commentTextProblem, emitComment, type CommentTarget } from './lib/commentEmit';

  let {
    target,
    label,
    current,
    text,
    ontext,
    ondraft,
    oncancel,
  }: {
    target: CommentTarget;
    /** What is being commented, for the heading (`public.customers.email`). */
    label: string;
    /** The comment exactly as it stands in the database; `null` for none.
     *  `undefined` means the payload carried no verbatim text — a context from
     *  a build before this field existed — and the editor refuses rather than
     *  seed from a processed form. */
    current: string | null | undefined;
    /** What has been typed. Owned by the PANE, not by this component: the editor
     *  renders inside the Semantics branch, so visiting another tab unmounts it,
     *  and a value living here would be replaced by the database seed on the way
     *  back — silently, with the operator's text gone. */
    text: string;
    ontext: (next: string) => void;
    ondraft: (sql: string) => void;
    oncancel: () => void;
  } = $props();

  const known = $derived(current !== undefined);
  // An empty body IS removal: PostgreSQL stores no such thing as an empty
  // comment — `IS ''` drops it exactly as `IS NULL` does (measured). So there is
  // one control here and not two, and the generator writes `IS NULL` for both.
  const nextValue = $derived<string | null>(text === '' ? null : text);
  const problem = $derived(commentTextProblem(text));
  const unchanged = $derived(known && nextValue === (current === '' ? null : (current ?? null)));

  const sql = $derived.by(() => {
    if (!known || problem !== null) return null;
    try {
      return emitComment(target, nextValue);
    } catch {
      return null;
    }
  });

  function draft(): void {
    if (sql === null) return;
    ondraft(sql);
  }
</script>

<div class="editor" data-testid="comment-editor">
  <h4>Edit comment - <code>{label}</code></h4>

  {#if !known}
    <p class="err" data-testid="comment-editor-unknown">
      This inspection carries no verbatim COMMENT for {label}. Re-inspect the profile to edit it -
      the rendered description is a processed form and editing that would drop
      <code>@widget:</code> / <code>@example:</code> tags.
    </p>
  {:else}
    <textarea
      data-testid="comment-text"
      rows="6"
      value={text}
      oninput={(e) => ontext(e.currentTarget.value)}
      spellcheck="false"
      placeholder="Plain text. @ai: and @policy: lines are part of the comment and are kept as written."
    ></textarea>
    <p class="hint">
      The comment exactly as it stands in the database. Leave it empty to remove it - PostgreSQL
      stores no empty comment, so that is the same thing.
    </p>

    {#if problem !== null}
      <p class="err" data-testid="comment-problem">{problem}</p>
    {/if}
    {#if unchanged}
      <p class="note" data-testid="comment-unchanged">
        Same as what is in the database - drafting this changes nothing.
      </p>
    {/if}
    {#if sql !== null}
      <pre class="sql" data-testid="comment-sql">{sql}</pre>
    {/if}
  {/if}

  <div class="actions">
    <button type="button" data-testid="comment-draft" onclick={draft} disabled={sql === null}>
      Add to drafts
    </button>
    <button type="button" data-testid="comment-cancel" onclick={oncancel}>Cancel</button>
  </div>
</div>

<style>
  .editor {
    border: 1px solid #d4d9e6;
    border-radius: 6px;
    background: #fbfcff;
    padding: 0.5rem 0.6rem;
    margin: 0.4rem 0;
  }
  h4 {
    margin: 0 0 0.4rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #666;
  }
  code {
    font-family: ui-monospace, monospace;
    text-transform: none;
    letter-spacing: 0;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    padding: 0.35rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    resize: vertical;
  }
  .hint {
    color: #888;
    font-size: 0.75rem;
    margin: 0.3rem 0;
  }
  pre.sql {
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    background: #fff;
    border: 1px solid #e4e4e4;
    border-radius: 4px;
    padding: 0.4rem;
    margin: 0.3rem 0;
  }
  .err {
    color: #a12a2a;
    font-size: 0.78rem;
    margin: 0.3rem 0;
  }
  .note {
    color: #7a4b00;
    font-size: 0.75rem;
    margin: 0.3rem 0;
  }
  .actions {
    display: flex;
    gap: 0.4rem;
    margin-top: 0.3rem;
  }
  .actions button {
    padding: 0.2rem 0.7rem;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: 0.78rem;
  }
  .actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
