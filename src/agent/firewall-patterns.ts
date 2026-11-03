/**
 * Catálogo de patrones del cortafuegos determinista.
 *
 * **Vive en código a propósito.** Ver `firewall.ts` para el razonamiento
 * completo: la configuración por cliente puede AÑADIR patrones, nunca quitarlos
 * ni sustituirlos, porque un error de edición en un YAML no puede tener como
 * consecuencia que el cortafuegos deje de detectar una urgencia.
 *
 * Los patrones se evalúan sobre texto normalizado: minúsculas, sin tildes, sin
 * puntuación y con las repeticiones de letras colapsadas. Escríbelos así.
 */

export const CATEGORIAS = [
  'urgencia_clinica',
  'minoria_de_edad',
  'derechos_rgpd',
  'baja',
  'contenido_clinico',
] as const;

export type Categoria = (typeof CATEGORIAS)[number];

export interface Patron {
  readonly id: string;
  readonly categoria: Categoria;
  readonly regex: RegExp;
}

/**
 * Orden de prioridad cuando un mensaje dispara varias categorías. La urgencia
 * gana siempre: si alguien dice «dadme de baja, me sale pus», lo que no puede
 * pasar es que la baja tape la urgencia.
 */
export const PRIORIDAD: readonly Categoria[] = [
  'urgencia_clinica',
  'minoria_de_edad',
  // Por delante de `baja`: «quiero que borréis mis datos» es una solicitud de
  // derechos, no un darse de baja. Si `baja` ganara, se resolvería con una fila
  // en una tabla y nadie tramitaría el derecho.
  'derechos_rgpd',
  'baja',
  'contenido_clinico',
];

function p(id: string, categoria: Categoria, regex: RegExp): Patron {
  return { id, categoria, regex };
}

/**
 * Urgencia clínica: algo que puede estar haciéndole daño a una persona ahora
 * mismo. Es la categoría donde el falso negativo es inaceptable, así que los
 * patrones son deliberadamente anchos.
 */
const URGENCIA: readonly Patron[] = [
  p('sangrado', 'urgencia_clinica', /\bsangr\w*|\bsangre\b|\bsangrre\w*|\bme\s+sale\s+sangre\b/),
  p('respiracion', 'urgencia_clinica', /no\s+puedo\s+respirar|me\s+cuesta\s+respirar|me\s+ahogo|falta\s+de\s+aire|me\s+falta\s+el\s+aire/),
  p('infeccion', 'urgencia_clinica', /\bpus\b|\binfec\w*|\binfex\w*|\bsupura\w*|\bmal\s+olor\b|liquido\s+amarill\w*|\bverdoso\b/),
  // `quem\w*` es ancho a conciencia: se come «quemar grasa» como falso positivo
  // y a cambio no se le escapa «me queme», «me quemo» ni «quemazon».
  p('quemadura', 'urgencia_clinica', /\bquem\w*|\bampoll\w*|\bllaga\w*|\bescaldad\w*/),
  p('reaccion_alergica', 'urgencia_clinica', /\balergi\w*|reaccion\w*|\burticaria\b|\bronch\w*|\bhabones\b|\bse\s+me\s+cierra\s+la\s+garganta\b|\banafila\w*/),
  p('hinchazon', 'urgencia_clinica', /\bhinchad\w*|\bhinchaz\w*|\binflamad\w*|\bse\s+me\s+ha\s+hinchado\b|\bdeforme\b/),
  p('fiebre', 'urgencia_clinica', /\bfiebre\b|\bdecimas\b|\btiritona\w*|\bescalofri\w*/),
  p('dolor_intenso', 'urgencia_clinica', /no\s+aguanto\s+el\s+dolor|dolor\s+(insoportable|horrible|brutal|fuertisimo|muy\s+fuerte)|me\s+duele\s+(muchisimo|un\s+monton|un\s+huevo|horrores|a\s+rabiar)|\bme\s+muero\s+de\s+dolor\b/),
  p('neurologico', 'urgencia_clinica', /\bme\s+desmay\w*|\bmareo\w*|\bvision\s+borrosa\b|no\s+(siento|noto)\s+(la\s+cara|el\s+labio|la\s+zona)|no\s+puedo\s+(mover|abrir)\s+\w+|\bse\s+me\s+ha\s+torcido\b|\bparalizad\w*/),
  p('necrosis', 'urgencia_clinica', /\bnecro\w*|\bse\s+me\s+cae\s+la\s+piel\b|\bpiel\s+negra\b|\bmorad\w*|\bmoraton\w*|\bhematoma\w*|\bviolace\w*|\bse\s+me\s+esta\s+cayendo\b/),
  p('urgencia_explicita', 'urgencia_clinica', /\burgencia\w*\b|\burgente\b|\bemergencia\b|\bal\s+hospital\b|\ba\s+urgencias\b|\b112\b/),
];

/**
 * Contenido clínico: salud que el modelo no puede tratar, pero sin la premura
 * de una urgencia. También corta.
 */
const CLINICO: readonly Patron[] = [
  p('dolor', 'contenido_clinico', /\bme\s+duele\w*|\bdolor\w*|\bescuece\w*|\bpica\w*|\bardor\b|\bmolestia\w*|\bme\s+arde\b/),
  p('lesion', 'contenido_clinico', /\bbulto\w*|\bbultito\w*|\blunar\w*|\bmancha\w*|\bcicatriz\w*|\bherida\w*|\bcostra\w*|\bpupa\w*|\bgranos?\b/),
  p('embarazo', 'contenido_clinico', /\bembaraz\w*|\bpreñad\w*|\blactancia\b|\bdando\s+el\s+pecho\b|\bamamant\w*/),
  p('medicacion', 'contenido_clinico', /\bmedicaci\w*|\bpastill\w*|\banticoagul\w*|\broacut\w*|\bisotretin\w*|\bcorticoid\w*|\bantibiotic\w*|\bantidepres\w*|\bsintrom\b|\bme\s+tomo\s+unas?\b/),
  p('patologia', 'contenido_clinico', /\bdiabet\w*|\bhipertens\w*|\btiroid\w*|\blupus\b|\bpsoriasis\b|\bdermatitis\b|\brosacea\b|\bepileps\w*|\bvitiligo\b|\bqueloid\w*/),
  p('oncologia', 'contenido_clinico', /\bcancer\w*|\bquimio\w*|\bradioterap\w*|\bmelanom\w*|\btumor\w*|\bmetasta\w*|\boncolog\w*/),
  p('cirugia', 'contenido_clinico', /\bopera(ron|d[oa]s?|ci\w*)\b|\bme\s+operar\w*|\bcirugi\w*|\bquirurgic\w*|\bpuntos\b|\bprotesis\b|\bimplante\w*|\bmarcapasos\b/),
  p('pregunta_clinica', 'contenido_clinico', /\bes\s+normal\b|\bsera\s+normal\b|\bes\s+peligros\w*|\bpuedo\s+hacerme\w*\s+(el|la|un|una)\b.*\bsi\s+(tengo|estoy|tomo)\b|\bcontraindicad\w*|\befectos?\s+secundari\w*/),
  p('alergia_declarada', 'contenido_clinico', /\balergic\w*\s+a\b|\bintolerante\s+a\b/),
];

/**
 * Solicitud de baja. Ancha por diseño: no honrar una baja es de las cosas que
 * más caro salen, y el coste de darla de más es una llamada de recepción.
 */
const BAJA: readonly Patron[] = [
  // El «de» se escribe «d» constantemente en WhatsApp, y la baja no se puede
  // perder por una preposición: basta con que «baja» aparezca cerca de un verbo
  // de querer o de dar.
  p('baja_explicita', 'baja', /\b(darme|darse|dame|dadme|dar|doy|kiero|quiero|queria)\b[^.]{0,20}?\bbaja\b|\bd[e]?\s+baja\b|\bbaja\s+d[e]?\s+la\s+lista\b|\bdesuscri\w*|\bunsubscribe\b|\bstop\b/),
  p('no_escribir', 'baja', /no\s+(me\s+)?(volvais|volveis|vuelvan|querais)?\s*(a\s+)?(escrib\w*|mand\w*|manteis|envi\w*|contact\w*)|dejad\s+de\s+(escrib\w*|mand\w*|molest\w*)|no\s+quiero\s+(recibir|mas\s+mensajes|que\s+me\s+escrib\w*)|\bno\s+me\s+mandeis\s+mas\b|\bborrad\s+mi\s+numero\b/),
  p('queja_spam', 'baja', /\bes\s+spam\b|\besto\s+es\s+spam\b|\bdenunciar\w*|\bos\s+voy\s+a\s+denunciar\b|\bacoso\b/),
];

/**
 * Solicitudes de derechos del RGPD.
 *
 * **No es lo mismo que una baja y no se puede tratar igual.** Una baja comercial
 * se resuelve con una fila en una tabla; acceso, rectificación, supresión,
 * oposición, limitación y portabilidad son derechos con plazo legal de un mes, y
 * los resuelve **la clínica**, que es la responsable del tratamiento. Nosotros
 * somos encargados: no decidimos, asistimos.
 *
 * De ahí que el agente no conteste a esto por su cuenta: acusa recibo, registra
 * y deriva. Y deriva a quien la clínica haya designado para protección de datos,
 * que no tiene por qué ser recepción.
 *
 * La única excepción es la oposición a comunicaciones comerciales, que sí se
 * ejecuta al momento porque hay instrucción permanente del responsable en el
 * contrato de encargo. Eso es la baja de siempre y se queda en `baja`.
 */
const DERECHOS: readonly Patron[] = [
  p(
    'derechos_explicito',
    'derechos_rgpd',
    /\brgpd\b|\blopd\b|\bproteccion\s+de\s+datos\b|\bejercer\s+mis\s+derechos\b|\bderecho\s+al\s+olvido\b|\bhabeas\s+data\b|\bagencia\s+espanola\s+de\s+proteccion\b|\baepd\b/,
  ),
  p(
    'derecho_supresion',
    'derechos_rgpd',
    /\b(borrar|borrad|borreis|eliminar|elimina|suprimir|suprimid)\b[^.]{0,25}?\b(mis\s+datos|mi\s+historial|mi\s+ficha|mi\s+expediente|todo\s+lo\s+que\s+teneis\s+de\s+mi)\b|\bderecho\s+de\s+supresion\b/,
  ),
  p(
    'derecho_acceso',
    'derechos_rgpd',
    /\b(que|quiero|querria|solicito|dadme|denme)\b[^.]{0,25}?\b(datos|informacion)\b[^.]{0,25}?\b(teneis|tienen|guardais|guardan)\b|\bderecho\s+de\s+acceso\b|\bcopia\s+de\s+mis\s+datos\b|\bque\s+datos\s+teneis\s+(de\s+mi|mios)\b/,
  ),
  p(
    'derecho_rectificacion',
    'derechos_rgpd',
    /\bderecho\s+de\s+rectificacion\b|\brectificar\s+mis\s+datos\b|\bcorregir\s+mis\s+datos\b/,
  ),
  p(
    'derecho_portabilidad',
    'derechos_rgpd',
    /\bportabilidad\b|\bllevarme\s+mis\s+datos\b|\btrasladar\s+mis\s+datos\b/,
  ),
  p(
    'derecho_limitacion',
    'derechos_rgpd',
    /\blimitacion\s+del\s+tratamiento\b|\bque\s+dejeis\s+de\s+tratar\s+mis\s+datos\b|\bderecho\s+de\s+oposicion\b/,
  ),
];

/**
 * Minoría de edad. Sólo dispara con una edad declarada explícitamente en años
 * o con una declaración directa, para no confundir «tengo 17 lunares» con una
 * edad. La cifra 18 y superiores NO disparan.
 */
const MENOR: readonly Patron[] = [
  p('edad_declarada', 'minoria_de_edad', /\b(tengo|tiene|cumpl\w+|voy\s+a\s+cumplir)\b[^.]{0,20}?\b(1[0-7]|[1-9])\s*(anos|anitos|a\b)/),
  p('edad_en_letra', 'minoria_de_edad', /\b(tengo|tiene)\b[^.]{0,20}?\b(diez|once|doce|trece|catorce|quince|dieciseis|diecisiete)\s*(anos)?\b/),
  p('menor_explicito', 'minoria_de_edad', /\bsoy\s+menor\b|\bes\s+menor\b|\bmenor\s+de\s+edad\b|\baun\s+no\s+tengo\s+los\s+18\b|\btodavia\s+no\s+tengo\s+18\b|\bsoy\s+menorcita\b/),
  p('tutor', 'minoria_de_edad', /\bmi\s+hij[ao]\b[^.]{0,25}\b(1[0-7]|[1-9])\s*(anos)?\b|\bpara\s+mi\s+hij[ao]\s+de\s+(1[0-7]|[1-9])\b|\bva\s+al\s+instituto\b|\best[aá]\s+en\s+(1|2|3|4)\s*eso\b/),
];


/**
 * Cómo se nombra una zona tratada o una sesión anterior.
 *
 * **«desde la última sesión» es la señal más fuerte que puede llevar un mensaje
 * de estos y durante catorce fases no la miró nadie.** Un síntoma cualquiera
 * sobre piel que acabamos de tratar no es un comentario: es una posible
 * complicación post-tratamiento, y eso lo valora un sanitario hoy, no mañana.
 */
const CONTEXTO_TRATADO =
  '(la\\s+zona|la\\s+piel|donde\\s+me\\s+(lo\\s+)?(hicis\\w+|disteis|pusis\\w+|trat\\w+)|' +
  'desde\\s+(la|el)\\s+(ultima\\s+|ultimo\\s+)?(sesion|tratamiento|cita|vez)|' +
  'desde\\s+que\\s+me\\s+(lo\\s+)?(hice|hicis\\w+|trat\\w+|disteis)|' +
  '(tras|despues\\s+de)\\s+(la|el)\\s+(sesion|tratamiento|ultima)|' +
  'del\\s+laser|de\\s+la\\s+depilacion|del\\s+tratamiento|de\\s+la\\s+sesion)';

/**
 * Cualquier descripción física, por suave que sea. Aquí entran adjetivos que
 * solos no dirían nada —«rara», «distinta», «marca»— porque junto a una zona
 * tratada sí dicen.
 */
const DESCRIPCION_FISICA =
  '(roj\\w*|colorad\\w*|enrojec\\w*|irritad\\w*|irritacion|hinchad\\w*|inflamad\\w*|' +
  'marcad\\w*|marca\\w*|senal\\w*|rar[ao]\\w*|extran\\w*|distint\\w*|diferente|' +
  'sensible|caliente|ardiend\\w*|dur[ao]\\w*|durez\\w*|abultad\\w*|bulto\\w*|' +
  'manchit\\w*|mancha\\w*|granit\\w*|grano\\w*|costr\\w*|ampoll\\w*|' +
  'morad\\w*|amoratad\\w*|hematoma\\w*|oscur\\w*|blanquec\\w*|' +
  'escuec\\w*|escozor|pica\\w*|picor\\w*|tirante\\w*|tirantez|' +
  'hormigue\\w*|adormecid\\w*|dormid[ao]\\w*|sarpullid\\w*|ronch\\w*|' +
  'descam\\w*|pelan\\w*|pelad\\w*|supur\\w*|liquid\\w*|' +
  'peor|mal\\b|fatal|feo|fea)';

/**
 * Síntomas en registro atenuado.
 *
 * **El fallo que los trajo:** «por cierto, desde la última sesión tengo la zona
 * un poco roja» no disparó ningún patrón. Se fue al clasificador, que lo marcó
 * como queja comercial, severidad 2. Los veinte adversariales que había estaban
 * escritos como mensajes que SUENAN a urgencia —dolor, sangrado, pus— y éste
 * suena a comentario de pasada.
 *
 * Y así es como habla la gente cuando algo le preocupa pero no quiere alarmar:
 * quitándole importancia. **El registro atenuado no es el caso raro, es el
 * normal**, y escribir los adversariales sólo en registro alarmado dejaba fuera
 * justo la mitad que más se parece a la realidad.
 */
const ATENUADOS: readonly Patron[] = [
  // Zona tratada o sesión previa + CUALQUIER descripción física, en cualquier
  // orden. Urgencia: sobre piel recién tratada, «un poco roja» es un posible
  // efecto adverso y lo valora un sanitario, no el modelo ni recepción.
  p(
    'sintoma_post_tratamiento',
    'urgencia_clinica',
    new RegExp(
      `${CONTEXTO_TRATADO}[^.]{0,45}?${DESCRIPCION_FISICA}|` +
        `${DESCRIPCION_FISICA}[^.]{0,45}?${CONTEXTO_TRATADO}`,
    ),
  ),

  // Enrojecimiento e irritación sueltos: descripción física inequívoca aunque
  // no se nombre la sesión. Sin la premura de la urgencia, pero no lo contesta
  // el modelo.
  p(
    'enrojecimiento',
    'contenido_clinico',
    /\b(roj[ao]|rojiz\w*|colorad[ao]|enrojec\w*|irritad[ao]|irritacion|sarpullid\w*|ronchit\w*|escozor|tirantez|descam\w*|se\s+me\s+pela|granit\w*|manchit\w*|amoratad\w*)\b/,
  ),

  // «la noto rara», «se me ha quedado marca»: vagos, pero referidos al cuerpo.
  p(
    'sensacion_rara',
    'contenido_clinico',
    /\b(la|lo|las|los|me)\s+(noto|veo|siento|encuentro)\b[^.]{0,20}?\b(rar[ao]|extran\w*|distint\w*|mal|peor|feo|fea|dur[ao]|sensible|hinchad\w*)\b|\bme\s+(ha\s+)?qued\w*\b[^.]{0,20}?\b(marca|senal|mancha|cicatriz|bulto|durez\w*)/,
  ),

  /**
   * Las fórmulas con que se quita importancia a algo que preocupa, junto a una
   * parte del cuerpo. «Por cierto» y «una cosa» no dicen nada por sí solos —hay
   * que exigirles compañía— pero son exactamente el envoltorio con el que la
   * gente cuenta lo que no quiere convertir en un problema.
   */
  p(
    'atenuador_con_cuerpo',
    'contenido_clinico',
    new RegExp(
      '(por\\s+cierto|una\\s+cosa|otra\\s+cosa|oye|no\\s+se\\s+si\\s+es\\s+normal|' +
        'no\\s+se\\s+si\\s+sera\\s+normal|seguramente\\s+no\\s+(sea|es)\\s+nada|' +
        'no\\s+creo\\s+que\\s+sea\\s+nada|igual\\s+es\\s+una\\s+tonteria|' +
        'no\\s+es\\s+nada\\s+(grave|importante)|perdona\\s+que\\s+pregunte|' +
        'sin\\s+darle\\s+importancia|una\\s+dudilla|una\\s+pregunta\\s+tonta)' +
        // Hace falta un verbo de EXPERIENCIA en medio. Sin él, «por cierto,
        // ¿cuánto cuesta la zona de axilas?» cortaba: una pregunta de precio
        // convertida en escalado clínico. El falso positivo es barato cuando
        // cae sobre un mensaje ambiguo de salud, no cuando cae sobre el flujo
        // principal del negocio varias veces al día.
        '[^.]{0,40}?' +
        // Con \\b: sin él, «esta» casaba dentro de «cu-esta» y una pregunta de
        // precio se convertía en un escalado clínico.
        '\\b(tengo|noto|siento|me\\s+sale|me\\s+ha\\s+salido|se\\s+me\\s+ha|se\\s+me\\s+esta|' +
        'me\\s+(ha\\s+)?qued\\w+|llevo|veo|esta|estoy)\\b' +
        '[^.]{0,30}?' +
        '(la\\s+zona|la\\s+piel|la\\s+cara|el\\s+labio|la\\s+axila|las\\s+axilas|' +
        'la\\s+ingle|las\\s+ingles|la\\s+pierna|las\\s+piernas|el\\s+cuello|' +
        'el\\s+parpado|la\\s+barbilla|la\\s+frente|el\\s+pecho|la\\s+espalda|' +
        'el\\s+brazo|los\\s+brazos|el\\s+labio|la\\s+nariz|la\\s+tripa)',
    ),
  ),
];

export const CATALOGO: readonly Patron[] = [
  ...URGENCIA,
  ...ATENUADOS,
  ...MENOR,
  ...DERECHOS,
  ...BAJA,
  ...CLINICO,
];
