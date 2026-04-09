import { useState, useRef, type ReactNode, type CSSProperties } from 'react';
import { oklchShadow } from '../utils/colorUtils';

interface PushDownButtonProps {
  children: ReactNode;
  onTap?: () => void;
  color: string;
  borderRadius?: number;
  height?: number;
  bottomBorderWidth?: number;
  bottomBorderColor?: string;
  style?: CSSProperties;
}

export function PushDownButton({
  children,
  onTap,
  color,
  borderRadius = 21,
  height = 64,
  bottomBorderWidth = 6.5,
  bottomBorderColor,
  style,
}: PushDownButtonProps) {
  const [pressed, setPressed] = useState(false);
  const bottomColor = bottomBorderColor ?? oklchShadow(color);
  const faceHeight = height - bottomBorderWidth;
  const outerStrokeColor = `${bottomColor}40`; // ~25% alpha
  const innerStrokeColor = oklchShadow(color, 0.06);
  const travel = pressed ? bottomBorderWidth : 0;

  const handleClick = () => {
    if (!onTap) return;
    setPressed(true);
    setTimeout(() => {
      onTap();
      setPressed(false);
    }, 100);
  };

  return (
    <div
      onClick={handleClick}
      style={{
        height,
        position: 'relative',
        cursor: onTap ? 'pointer' : 'default',
        userSelect: 'none',
        ...style,
      }}
    >
      {/* Bottom layer */}
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: faceHeight,
        borderRadius,
        backgroundColor: bottomColor,
        boxShadow: `0 0 0 3.5px ${outerStrokeColor}`,
      }} />
      {/* Top layer */}
      <div style={{
        position: 'relative',
        height: faceHeight,
        marginTop: travel,
        borderRadius,
        backgroundColor: color,
        border: `2.5px solid ${innerStrokeColor}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'margin-top 0.1s ease',
      }}>
        {children}
      </div>
    </div>
  );
}

interface InsetTextFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  color?: string;
  borderRadius?: number;
  depth?: number;
  style?: CSSProperties;
  inputStyle?: CSSProperties;
}

export function InsetTextField({
  value,
  onChange,
  placeholder,
  color = '#F8F8F9',
  borderRadius = 14,
  depth = 2.5,
  style,
  inputStyle,
}: InsetTextFieldProps) {
  const backColor = oklchShadow(color);
  const innerStrokeColor = oklchShadow(color, 0.06);

  return (
    <div style={{ position: 'relative', ...style }}>
      {/* Back face */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: depth,
        borderRadius,
        backgroundColor: backColor,
      }} />
      {/* Front face */}
      <div style={{
        position: 'relative',
        marginTop: depth,
        borderRadius,
        backgroundColor: color,
        border: `2.5px solid ${innerStrokeColor}`,
      }}>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            padding: '10px 12px',
            fontSize: 16,
            fontWeight: 600,
            fontFamily: 'inherit',
            color: '#1E1E2C',
            ...inputStyle,
          }}
        />
      </div>
    </div>
  );
}

interface SunkenPushDownButtonProps {
  children: ReactNode;
  color: string;
  borderRadius?: number;
  depth?: number;
  style?: CSSProperties;
}

export function SunkenPushDownButton({
  children,
  color,
  borderRadius = 12,
  depth = 4,
  style,
}: SunkenPushDownButtonProps) {
  const backColor = oklchShadow(color);
  const innerStrokeColor = oklchShadow(color, 0.06);

  return (
    <div style={{
      position: 'relative',
      height: '100%',
      width: '100%',
      ...style,
    }}>
      {/* Back face */}
      <div style={{
        position: 'absolute',
        inset: 0,
        borderRadius,
        backgroundColor: backColor,
      }} />
      {/* Front face */}
      <div style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        top: depth,
        borderRadius,
        backgroundColor: color,
        border: `2.5px solid ${innerStrokeColor}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {children}
      </div>
    </div>
  );
}
