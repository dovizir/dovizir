import { createBrowserRouter } from "react-router-dom";
import { lazy, Suspense, type ComponentType } from "react";
import ConsumerLayout from "./routes/consumer/layout";
import DeskLayout from "./routes/desk/layout";
import PosLayout from "./routes/pos/layout";
import NotesLayout from "./routes/consumer/notes/layout";

// Lazy route element with a null fallback (pages render their own skeletons).
function L(loader: () => Promise<{ default: ComponentType<any> }>) {
  const C = lazy(loader);
  return (
    <Suspense fallback={null}>
      <C />
    </Suspense>
  );
}

export const router = createBrowserRouter([
  {
    element: <ConsumerLayout />,
    children: [
      { index: true, element: L(() => import("./routes/consumer/page")) },
      { path: "deposit", element: L(() => import("./routes/consumer/deposit/page")) },
      { path: "send", element: L(() => import("./routes/consumer/send/page")) },
      { path: "pay", element: L(() => import("./routes/consumer/pay/page")) },
      { path: "redeem", element: L(() => import("./routes/consumer/redeem/page")) },
      { path: "rates", element: L(() => import("./routes/consumer/rates/page")) },
      { path: "cash-in", element: L(() => import("./routes/consumer/cash-in/page")) },
      { path: "cash-out", element: L(() => import("./routes/consumer/cash-out/page")) },
      { path: "market", element: L(() => import("./routes/consumer/market/page")) },
      { path: "market/create", element: L(() => import("./routes/consumer/market/create/page")) },
      { path: "market/:id", element: L(() => import("./routes/consumer/market/[id]/page")) },
      {
        path: "notes",
        element: <NotesLayout />,
        children: [
          { index: true, element: L(() => import("./routes/consumer/notes/page")) },
          { path: "carve", element: L(() => import("./routes/consumer/notes/carve/page")) },
          { path: "pay", element: L(() => import("./routes/consumer/notes/pay/page")) },
          { path: "receive", element: L(() => import("./routes/consumer/notes/receive/page")) },
          { path: "reconcile", element: L(() => import("./routes/consumer/notes/reconcile/page")) },
          { path: "demo", element: L(() => import("./routes/consumer/notes/demo/page")) },
        ],
      },
    ],
  },
  {
    element: <DeskLayout />,
    children: [
      { path: "desk", element: L(() => import("./routes/desk/desk/page")) },
      { path: "desk/rates", element: L(() => import("./routes/desk/desk/rates/page")) },
      { path: "desk/rfq", element: L(() => import("./routes/desk/desk/rfq/page")) },
      { path: "desk/orders", element: L(() => import("./routes/desk/desk/orders/page")) },
      { path: "desk/disputes", element: L(() => import("./routes/desk/desk/disputes/page")) },
    ],
  },
  {
    element: <PosLayout />,
    children: [{ path: "pos", element: L(() => import("./routes/pos/pos/page")) }],
  },
]);
