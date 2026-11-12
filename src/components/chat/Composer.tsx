'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, StopIcon } from './icons';

export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
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
          placeholder="Ask anything"
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Message"
          disabled={disabled}
        />
        {busy ? (
          <button className="send-button" data-stop="true" onClick={onStop} type="button" aria-label="Stop">
            <StopIcon />
          </button>
        ) : (
          <button
            className="send-button"
            onClick={submit}
            type="button"
            disabled={!value.trim() || disabled}
            aria-label="Send"
          >
            <ArrowUpIcon />
          </button>
        )}
      </div>
    </div>
  );
}
