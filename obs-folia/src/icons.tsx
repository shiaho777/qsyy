// Lightweight inline replacements for the two lucide-react icons the ported
// components use (Hourglass in VisualizerFume). Paths follow lucide's ISC
// licensed icon geometry; no icon library is bundled.
// AGPL-3.0 module. See ../NOTICE.md and ../LICENSE.
import React from 'react';

interface IconProps {
    size?: number | string;
    className?: string;
    style?: React.CSSProperties;
}

export const Hourglass: React.FC<IconProps> = ({ size = 24, className, style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
        aria-hidden="true"
    >
        <path d="M5 22h14" />
        <path d="M5 2h14" />
        <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
        <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
);