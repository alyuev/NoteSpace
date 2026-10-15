// d3-force-3d ships without type definitions; only the parts we use are declared.
declare module 'd3-force-3d' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export function forceSimulation(nodes?: any[], numDimensions?: 1 | 2 | 3): any;
  export function forceManyBody(): any;
  export function forceCollide(radius?: number | ((node: any) => number)): any;
  export function forceLink(links?: any[]): any;
  export function forceX(x?: number): any;
  export function forceY(y?: number): any;
  export function forceZ(z?: number): any;
}
