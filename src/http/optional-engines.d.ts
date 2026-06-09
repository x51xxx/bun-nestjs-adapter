/**
 * Minimal type surface for the optional view-engine peer dependencies that
 * ship without their own type definitions. Only the entry points
 * `renderTemplate()` touches are declared.
 */
declare module 'ejs' {
  export function render(
    template: string,
    data?: object,
    options?: { filename?: string },
  ): string;
  const ejs: { render: typeof render };
  export default ejs;
}

declare module 'pug' {
  export function compile(
    template: string,
    options?: { filename?: string },
  ): (locals?: object) => string;
  const pug: { compile: typeof compile };
  export default pug;
}
