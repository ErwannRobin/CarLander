/**
 * Hairline icon set (24×24, 1.6 stroke, currentColor).
 */
import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'pause'
  | 'restart'
  | 'controls'
  | 'settings'
  | 'back'
  | 'lock'
  | 'check'
  | 'close'
  | 'play'
  | 'chevronRight'
  | 'thrust'
  | 'stabilize'
  | 'vacuum'
  | 'rollLeft'
  | 'rollRight'
  | 'stick'
  | 'jump'
  | 'gas'
  | 'brake'
  | 'tilt';

const PATHS: Record<IconName, ReactNode> = {
  pause: (
    <>
      <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  restart: (
    <>
      <path d="M19.2 12a7.2 7.2 0 1 1-2.1-5.1" />
      <path d="M19.4 4.6v4.2h-4.2" />
    </>
  ),
  controls: (
    <>
      <rect x="2.8" y="6.5" width="18.4" height="11" rx="2.2" />
      <path d="M6.5 10h.01M9.5 10h.01M12.5 10h.01M15.5 10h.01M17.8 10h.01M8 14h8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  back: <path d="M14.5 5.5 8 12l6.5 6.5" />,
  chevronRight: <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  lock: (
    <>
      <rect x="5.5" y="10.5" width="13" height="9.5" rx="1.8" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  check: <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  play: <path d="M8 5.8v12.4l9.8-6.2z" fill="currentColor" stroke="none" />,
  // rocket plume
  thrust: (
    <>
      <path d="M12 3.2c1.7 3.1 5.2 5.4 5.2 9.7a5.2 5.2 0 0 1-10.4 0c0-2.4 1.2-4 2.5-5.3.3 1.6 1 2.6 2.1 3 0-2.6.2-5.1.6-7.4z" />
      <path d="M12 20.6v-3.4" opacity="0.6" />
    </>
  ),
  // gyro: horizon line through a level ring
  stabilize: (
    <>
      <circle cx="12" cy="12" r="5.2" />
      <path d="M2.8 12h4M17.2 12h4M12 6.8v2" />
    </>
  ),
  // suction: two arrows pulling onto the track
  vacuum: (
    <>
      <path d="M8 4.5v8.5M5.2 10.4 8 13.2l2.8-2.8M16 4.5v8.5M13.2 10.4l2.8 2.8 2.8-2.8" />
      <path d="M3.5 18.5h17" />
    </>
  ),
  // front view of the car with a roll arrow over it
  rollLeft: (
    <>
      <rect x="6" y="14" width="12" height="4.6" rx="1.6" />
      <path d="M8.6 14l1.1-2.4h4.6l1.1 2.4" />
      <path d="M19.2 10.2a8.2 8.2 0 0 0-13.9-2" />
      <path d="M4.6 4.4v4h4" />
    </>
  ),
  rollRight: (
    <>
      <rect x="6" y="14" width="12" height="4.6" rx="1.6" />
      <path d="M8.6 14l1.1-2.4h4.6l1.1 2.4" />
      <path d="M4.8 10.2a8.2 8.2 0 0 1 13.9-2" />
      <path d="M19.4 4.4v4h-4" />
    </>
  ),
  stick: (
    <>
      <circle cx="12" cy="12" r="8" opacity="0.55" />
      <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
    </>
  ),
  // vertical booster: arrow lifting off a deck with jets underneath
  jump: (
    <>
      <path d="M12 3.6v9.4M7.6 7.9 12 3.6l4.4 4.3" />
      <path d="M5.5 16.4h13" />
      <path d="M8.8 19v1.8M12 19v2.4M15.2 19v1.8" opacity="0.6" />
    </>
  ),
  // gas pedal: tall ribbed plate
  gas: (
    <>
      <rect x="8" y="3.8" width="8" height="16.4" rx="2.2" />
      <path d="M10.4 8.4h3.2M10.4 11.6h3.2M10.4 14.8h3.2" opacity="0.7" />
    </>
  ),
  // brake pedal: wide plate
  brake: (
    <>
      <rect x="4.6" y="7" width="14.8" height="10" rx="2.4" />
      <path d="M8.8 10.4h6.4M8.8 13.6h6.4" opacity="0.7" />
    </>
  ),
  // steering wheel
  tilt: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M3.8 11.2h6M14.2 11.2h6M12 14.2v6.2" />
    </>
  ),
};

export function Icon({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
