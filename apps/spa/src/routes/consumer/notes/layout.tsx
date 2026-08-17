import { Outlet } from "react-router-dom";
import { AirplaneProvider } from "@/lib/notes/airplane";

/** Offline-notes section: shares the demo airplane-mode context. */
export default function NotesLayout() {
  return <AirplaneProvider><Outlet /></AirplaneProvider>;
}
