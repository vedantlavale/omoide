import type { ReactNode } from 'react';

function Icon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const PlusIcon = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const MenuIcon = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon size={15}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </Icon>
);
export const CheckIcon = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const SlidersIcon = () => (
  <Icon size={15}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </Icon>
);
export const ArrowUpIcon = () => (
  <Icon size={17}>
    <path d="M12 19V5M12 5l-6 6M12 5l6 6" />
  </Icon>
);
export const StopIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <rect width="12" height="12" rx="2.5" fill="currentColor" />
  </svg>
);
export const GlobeIcon = () => (
  <Icon size={17}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" />
  </Icon>
);
export const TableIcon = () => (
  <Icon size={17}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 10h18M9 10v9" />
  </Icon>
);
export const ClockIcon = () => (
  <Icon size={17}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const TrendIcon = () => (
  <Icon size={17}>
    <path d="M3 17l6-6 4 4 8-8" />
    <path d="M15 7h6v6" />
  </Icon>
);
export const ExternalIcon = () => (
  <Icon size={12}>
    <path d="M14 4h6v6M20 4l-9 9M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
  </Icon>
);
export const ChevronIcon = () => (
  <Icon size={14}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon size={15}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
