'use client';

import { useEffect, useRef, useState } from 'react';

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  hint,
  initialValue,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  hint?: string;
  initialValue?: string;
}) {
  const [value, setValue] = useState(initialValue ?? '');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (initialValue !== undefined) setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || busy || disabled) return;
    onSend(text);
    setValue('');
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder="Ask about anything on the web — or about what we discussed before…"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Message"
          disabled={disabled}
        />
        {busy ? (
          <button className="send-button" data-stop="true" onClick={onStop} type="button" aria-label="Stop">
            <span style={{ width: 9, height: 9, background: 'currentColor', borderRadius: 2 }} />
          </button>
        ) : (
          <button
            className="send-button"
            onClick={submit}
            type="button"
            disabled={!value.trim() || disabled}
            aria-label="Send"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="composer-hint">
        <span>Enter to send · Shift+Enter for a new line</span>
        <span>{hint}</span>
      </div>
    </div>
  );
}
