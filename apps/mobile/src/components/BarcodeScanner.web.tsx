import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import { colors } from '../theme';
import { sanitizeScan } from '../scan/sanitize';

interface Props {
  active: boolean;
  onScanned: (data: string) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 1500;

// Formats kept in sync with the native scanner's barcodeTypes.
const DETECTOR_FORMATS = [
  'ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code', 'data_matrix',
];

type Status = 'loading' | 'ready' | 'denied';

export function BarcodeScanner({ active, onScanned, onClose }: Props) {
  const [status, setStatus] = useState<Status>('loading');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torch, setTorch] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const rafRef = useRef<number | null>(null);
  const zxingControlsRef = useRef<{ stop: () => void } | null>(null);
  const lastCode = useRef<string>('');
  const lastScanTime = useRef<number>(0);

  const emit = useCallback((raw: string) => {
    // Bound/clean before emitting — a malicious QR or runaway scanner can carry
    // megabytes or control-char junk; sanitizeScan returns null for those.
    const code = sanitizeScan(raw);
    if (!code) { console.warn('[BarcodeScanner] dropped invalid scan'); return; }
    const now = Date.now();
    if (code === lastCode.current && now - lastScanTime.current < DEBOUNCE_MS) return;
    lastScanTime.current = now;
    lastCode.current = code;
    onScanned(code);
  }, [onScanned]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    setStatus('loading');
    setTorch(false);
    setTorchSupported(false);

    const stopTracks = () => {
      const v = videoRef.current;
      const stream = (v?.srcObject as MediaStream | null) ?? null;
      stream?.getTracks().forEach(t => t.stop());
      if (v) v.srcObject = null;
      trackRef.current = null;
    };

    const cleanup = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (zxingControlsRef.current) {
        try { zxingControlsRef.current.stop(); } catch { /* noop */ }
        zxingControlsRef.current = null;
      }
      stopTracks();
    };

    const wireTorch = () => {
      const stream = (videoRef.current?.srcObject as MediaStream | null) ?? null;
      const track = stream?.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      const caps = (track?.getCapabilities?.() as { torch?: boolean } | undefined);
      if (caps && 'torch' in caps && caps.torch) setTorchSupported(true);
    };

    const start = async () => {
      try {
        const useDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;

        if (useDetector) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
          });
          if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
          const video = videoRef.current;
          if (!video) { stream.getTracks().forEach(t => t.stop()); return; }
          video.srcObject = stream;
          await video.play().catch(() => { /* autoplay race */ });
          if (cancelled) return;
          wireTorch();
          setStatus('ready');

          const Detector = (window as unknown as { BarcodeDetector: new (o?: unknown) => { detect: (s: CanvasImageSource) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
          let detector: { detect: (s: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };
          try {
            detector = new Detector({ formats: DETECTOR_FORMATS });
          } catch {
            detector = new Detector();
          }

          const tick = async () => {
            if (cancelled) return;
            const v = videoRef.current;
            if (v && v.readyState >= 2) {
              try {
                const codes = await detector.detect(v);
                if (codes && codes.length) emit(codes[0].rawValue);
              } catch { /* transient decode error */ }
            }
            if (!cancelled) rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        } else {
          // iOS Safari / Firefox: fall back to @zxing/browser.
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          if (cancelled) return;
          const reader = new BrowserMultiFormatReader();
          const video = videoRef.current;
          if (!video) return;
          const controls = await reader.decodeFromVideoDevice(undefined, video, (result) => {
            if (result) emit(result.getText());
          });
          if (cancelled) { try { controls.stop(); } catch { /* noop */ } return; }
          zxingControlsRef.current = controls;
          wireTorch();
          setStatus('ready');
        }
      } catch {
        if (!cancelled) {
          cleanup();
          setStatus('denied');
        }
      }
    };

    start();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [active, emit]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torch;
    try {
      // `torch` is a non-standard constraint not in TS's MediaTrackConstraints; cast through unknown.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorch(next);
    } catch { /* torch toggle unsupported */ }
  }, [torch]);

  if (!active) return null;

  if (status === 'denied') {
    return (
      <div style={styles.permBox}>
        <div style={styles.permIconWrap}><span style={styles.permIcon}>📷</span></div>
        <div style={styles.permTitle}>Camera access</div>
        <div style={styles.permText}>
          InventoryPro needs camera permission to scan barcodes and QR labels. Enable it in your
          browser, then try again.
        </div>
        <button style={styles.btn} onClick={onClose}>Close</button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={styles.video}
      />

      {/* Dim mask with a clear cut-out window */}
      <div style={styles.overlay}>
        <div style={styles.maskTop} />
        <div style={styles.maskMiddle}>
          <div style={styles.maskSide} />
          <div style={styles.frame}>
            <div style={{ ...styles.corner, ...styles.cornerTL }} />
            <div style={{ ...styles.corner, ...styles.cornerTR }} />
            <div style={{ ...styles.corner, ...styles.cornerBL }} />
            <div style={{ ...styles.corner, ...styles.cornerBR }} />
          </div>
          <div style={styles.maskSide} />
        </div>
        <div style={styles.maskBottom}>
          <div style={styles.hintPill}>
            <span style={styles.hintText}>Align the barcode or QR inside the frame</span>
          </div>
        </div>
      </div>

      {/* Top bar: close + torch */}
      <div style={styles.topBar}>
        <button style={styles.iconBtn} onClick={onClose} aria-label="Close scanner">✕</button>
        <span style={styles.title}>Scan</span>
        {torchSupported ? (
          <button
            style={{ ...styles.iconBtn, ...(torch ? styles.iconBtnActive : null) }}
            onClick={toggleTorch}
            aria-label={torch ? 'Turn flashlight off' : 'Turn flashlight on'}
          >
            {torch ? '🔦' : '💡'}
          </button>
        ) : (
          <span style={{ width: 42, height: 42 }} />
        )}
      </div>
    </div>
  );
}

const CORNER = 30;
const CT = 4;
const FRAME_W = 280;
const FRAME_H = 210;
const MASK = 'rgba(0,0,0,0.55)';

const styles: Record<string, CSSProperties> = {
  container: { position: 'absolute', inset: 0, backgroundColor: '#000', overflow: 'hidden' },
  video: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' },
  overlay: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' },
  maskTop: { flex: 1, backgroundColor: MASK },
  maskMiddle: { display: 'flex', flexDirection: 'row', height: FRAME_H },
  maskSide: { flex: 1, backgroundColor: MASK },
  maskBottom: { flex: 1, backgroundColor: MASK, display: 'flex', alignItems: 'center', flexDirection: 'column', paddingTop: 28 },
  frame: { position: 'relative', width: FRAME_W, height: FRAME_H, borderRadius: 18, overflow: 'hidden' },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: colors.primary, borderStyle: 'solid' },
  cornerTL: { top: 0, left: 0, borderTopWidth: CT, borderLeftWidth: CT, borderTopLeftRadius: 18 },
  cornerTR: { top: 0, right: 0, borderTopWidth: CT, borderRightWidth: CT, borderTopRightRadius: 18 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: CT, borderLeftWidth: CT, borderBottomLeftRadius: 18 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: CT, borderRightWidth: CT, borderBottomRightRadius: 18 },
  hintPill: {
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 999, padding: '10px 18px',
    border: '1px solid rgba(255,255,255,0.18)',
  },
  hintText: { color: '#fff', fontSize: 13.5, fontWeight: 500 },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: '52px 16px 12px',
  },
  title: { color: '#fff', fontSize: 17, fontWeight: 700, letterSpacing: 0.3 },
  iconBtn: {
    width: 42, height: 42, borderRadius: 21, cursor: 'pointer',
    backgroundColor: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 18, fontWeight: 700,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid rgba(255,255,255,0.2)',
  },
  iconBtnActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  permBox: {
    position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', gap: 14, padding: 32,
    backgroundColor: colors.background, textAlign: 'center',
  },
  permIconWrap: {
    width: 88, height: 88, borderRadius: 44, backgroundColor: colors.accentBg,
    display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  permIcon: { fontSize: 40 },
  permTitle: { fontSize: 20, fontWeight: 800, color: colors.textPrimary },
  permText: { fontSize: 15, color: colors.textSecondary, lineHeight: '22px', maxWidth: 300 },
  btn: {
    backgroundColor: colors.primary, color: '#fff', borderRadius: 12, border: 'none',
    padding: '14px 28px', marginTop: 8, minWidth: 220, fontWeight: 800, fontSize: 16, cursor: 'pointer',
  },
};
