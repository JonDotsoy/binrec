// Files imported `with { type: "text" }` are bundled as their text.
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
