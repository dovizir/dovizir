// next/link shim → react-router Link. next/link uses `href`; react-router uses
// `to`. This wrapper accepts `href` so ported components stay unchanged.
import { Link as RouterLink, type LinkProps as RouterLinkProps } from "react-router-dom";
import { forwardRef, type AnchorHTMLAttributes } from "react";

type NextLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
} & Omit<RouterLinkProps, "to">;

const Link = forwardRef<HTMLAnchorElement, NextLinkProps>(function Link(
  { href, ...props },
  ref,
) {
  return <RouterLink ref={ref} to={href} {...props} />;
});

export default Link;
