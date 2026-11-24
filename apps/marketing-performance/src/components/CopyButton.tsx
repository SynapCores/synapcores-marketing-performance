'use client';
import { useState } from 'react';

/** Copy text to the clipboard; falls back to selecting a prompt where the Clipboard API is blocked. */
export default function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt('Copy this link:', text);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  }
  return (
    <button type="button" onClick={copy} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-muted" data-copy={text}>
      {done ? 'Copied ✓' : label}
    </button>
  );
}
