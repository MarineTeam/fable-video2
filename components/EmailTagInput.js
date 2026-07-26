import { useState } from 'react';
import { XIcon } from './icons';

const SPLIT_RE = /[\s,;]+/;

// Multi-email entry as removable tags/chips instead of a raw comma-separated
// textarea — type (or paste) one or more emails, each becomes a chip on
// Enter/comma/space/blur/paste, and Backspace on an empty field removes the
// last one. `value` is always the array of committed emails; the in-progress
// text being typed is this component's own local state, never lifted.
export default function EmailTagInput({ value, onChange, placeholder, ariaLabel }) {
  const [draft, setDraft] = useState('');

  function commit(raw) {
    const parts = raw
      .split(SPLIT_RE)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    onChange([...new Set([...value, ...parts])]);
  }

  function removeTag(email) {
    onChange(value.filter((e) => e !== email));
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
        setDraft('');
      } else if (e.key === 'Enter') {
        e.preventDefault(); // never let a stray Enter submit the surrounding form
      }
    } else if (e.key === 'Tab' && draft.trim()) {
      commit(draft);
      setDraft('');
    } else if (e.key === 'Backspace' && !draft && value.length > 0) {
      removeTag(value[value.length - 1]);
    }
  }

  function onBlur() {
    if (draft.trim()) {
      commit(draft);
      setDraft('');
    }
  }

  function onPaste(e) {
    const text = e.clipboardData.getData('text');
    if (SPLIT_RE.test(text)) {
      e.preventDefault();
      commit(text);
      setDraft('');
    }
  }

  return (
    <div className="tag-input">
      {value.map((email) => (
        <span key={email} className="chip">
          {email}
          <button type="button" className="btn-icon" title="Remove" onClick={() => removeTag(email)}>
            <XIcon width={12} height={12} />
          </button>
        </span>
      ))}
      <input
        className="tag-input-field"
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onPaste={onPaste}
        placeholder={value.length === 0 ? placeholder : ''}
        aria-label={ariaLabel}
      />
    </div>
  );
}
