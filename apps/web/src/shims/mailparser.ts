export function simpleParser(): Promise<never> {
  return Promise.reject(
    new Error("mailparser is not available in the browser")
  );
}
