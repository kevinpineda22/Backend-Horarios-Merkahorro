import { z } from "zod";
import { isValidCedula, normalizeCedula } from "../../shared/cedula.js";

/** Body of POST /api/public/horarios/consulta. The cedula is normalized with the company-wide helper. */
export const consultaBodySchema = z.object({
  cedula: z
    .string({ required_error: "La cédula es obligatoria", invalid_type_error: "Cédula inválida" })
    .trim()
    .max(30, "Cédula inválida")
    .refine(isValidCedula, "Cédula inválida")
    .transform(normalizeCedula),
});
