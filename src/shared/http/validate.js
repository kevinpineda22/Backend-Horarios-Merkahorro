import { HttpError } from "./HttpError.js";

/**
 * Validates req.body / req.query / req.params against zod schemas. On success
 * the parsed (coerced) values replace the originals; on failure it answers
 * 400 VALIDATION_ERROR with the issue list in `details`.
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const details = [];
    for (const part of ["params", "query", "body"]) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part]);
      if (result.success) {
        // req.query is a getter in some Express versions; defineProperty is safe for all.
        Object.defineProperty(req, part, { value: result.data, writable: true, configurable: true });
      } else {
        for (const issue of result.error.issues) {
          details.push({ path: [part, ...issue.path].join("."), message: issue.message });
        }
      }
    }
    if (details.length === 0) return next();

    const err = new HttpError(400, "Datos de entrada inválidos", "VALIDATION_ERROR");
    err.details = details;
    return next(err);
  };
}
