// next/navigation shim → react-router. Maps the App-Router hooks the ported
// components use onto react-router equivalents.
import {
  useNavigate,
  useLocation,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from "react-router-dom";

export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (href: string) => navigate(href),
    replace: (href: string) => navigate(href, { replace: true }),
    back: () => navigate(-1),
    forward: () => navigate(1),
    // RSC-era no-ops: SPA data comes from react-query hooks, no router refresh.
    refresh: () => {},
    prefetch: () => {},
  };
}

export function usePathname(): string {
  return useLocation().pathname;
}

// next's useSearchParams returns the params object directly; react-router
// returns a [params, setter] tuple — unwrap so `.get()` calls work unchanged.
export function useSearchParams(): URLSearchParams {
  const [params] = useRouterSearchParams();
  return params;
}

export const useParams = useRouterParams;
