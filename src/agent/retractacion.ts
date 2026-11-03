/**
 * **El agente se desdice de algo que dijo la clínica.** Detector que avisa, no
 * bloquea.
 *
 * El caso: con la base de conocimiento desplegada y el freno viejo todavía en
 * el prompt, el paciente preguntó por el aparcamiento y el pago, recibió las
 * respuestas compuestas del YAML —verdad—, pidió cita, y el agente abrió con
 * «perdona, antes te di por buenas dos cosas que no me constan». 4 de 4 en la
 * tanda. Decirle a un paciente que el sistema le dio información falsa cuando
 * era verdad es peor que no contestarle.
 *
 * **No bloquea, a propósito**, como el detector de estilo:
 * - Es difuso. Las cuatro retractaciones medidas tenían cuatro formas, y una ni
 *   se disculpaba: «lo del aparcamiento mejor que te lo confirme recepción».
 * - Choca con lo legítimo: corregir un historial falso de verdad («lo del lunes
 *   no llegó a reservarse») es justo lo que se quiere.
 * - La validación compara con el estado, y esto no contradecía el estado:
 *   contradecía al prompt. La defensa buena es estructural —que el prompt no
 *   pueda contradecirse—, y esto es la red que lo enseña al medir, en la tanda y
 *   en el eval, y no cuando muerde.
 */

const SE_DESDICE: ReadonlyArray<{ id: string; regex: RegExp }> = [
  { id: 'te_lo_di_por_bueno', regex: /\b(te|le)\s+(di|dije|he dicho|hab[ií]a dicho|coment[eé])\b[^.]{0,60}\b(de m[aá]s|por buen[oa]s?|mal\b|sin saber)/i },
  { id: 'no_me_consta', regex: /\bno me consta(n)?\b/i },
  { id: 'no_debi_decirlo', regex: /\bno (deb[ií]|deber[ií]a|tendr[ií]a que) (haber(te)? )?(dicho|dec[ií]rtelo|decirlo|decir)/i },
  { id: 'me_equivoque', regex: /\bme (he )?(equivocad[oa]|equivoqu[eé]|liado|li[eé])\b/i },
  { id: 'rectifico', regex: /\b(rectifico|me corrijo|corrijo lo de antes)\b/i },
  {
    id: 'lo_de_antes_no_vale',
    regex: /\blo (de|del) [^.]{1,60}\b(mejor que te lo confirme|te lo (tiene que )?confirma(r)?|no te lo (puedo|pod[ií]a) (confirmar|asegurar)( yo)?)\b/i,
  },
];

/** El primer patrón que encaja, o `null`. */
export function seDesdice(texto: string): { id: string; fragmento: string } | null {
  for (const { id, regex } of SE_DESDICE) {
    const m = regex.exec(texto);
    if (m !== null) return { id, fragmento: m[0] };
  }
  return null;
}
