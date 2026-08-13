import { AirplaneProvider } from "@/lib/notes/airplane";

/** Offline-notes section: shares the demo airplane-mode context. */
export default function NotesLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AirplaneProvider>{children}</AirplaneProvider>;
}
