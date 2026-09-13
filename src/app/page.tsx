import { GameRoot } from "@/components/GameRoot";

/**
 * The single route. Everything below `GameRoot` is a client component, and the
 * Cesium subtree is loaded behind a `ssr: false` dynamic boundary so no part of
 * the 3D engine is ever evaluated on the server.
 */
export default function Page() {
  return <GameRoot />;
}
