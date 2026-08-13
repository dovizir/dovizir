"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Renders a payload string as a QR image (offline; pure client render). */
export function QrCode({ value, size = 208 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => alive && setDataUrl(url))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [value, size]);

  if (error) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-danger/40 bg-danger/10 p-md text-xs text-danger"
        style={{ width: size, height: size }}
      >
        QR too large
      </div>
    );
  }
  return (
    <div className="inline-block rounded-md bg-white p-sm" style={{ width: size + 16 }}>
      {dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={dataUrl} alt="QR code" width={size} height={size} />
      ) : (
        <div style={{ width: size, height: size }} />
      )}
    </div>
  );
}
