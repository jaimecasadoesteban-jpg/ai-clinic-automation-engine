import type { Clasificacion, FabricaDeAgente, Redaccion } from '../../src/service/ports.js';
import type { ContextoDeAgente, Agente } from '../../src/service/ports.js';

/**
 * Envuelve la fábrica real para poder enseñar por debajo qué se extrajo y
 * cuántos tokens costó cada llamada.
 *
 * Es un decorador del banco de pruebas: **no toca el código de producción**.
 * Lo que se ve es exactamente lo que el pipeline recibe.
 */
export class AgenteEspia implements FabricaDeAgente {
  clasificacion: Clasificacion | null = null;
  redacciones: Redaccion[] = [];
  /**
   * Lo que la validación le devolvió al modelo para que se corrigiera, con el
   * texto que bloqueó. Sin esto, «regeneraciones: 1» no dice qué regla saltó, y
   * una regla que salta en cada turno es fatiga de alertas en ciernes.
   */
  correcciones: Array<{ textoAnterior: string; explicacion: string }> = [];

  constructor(private readonly real: FabricaDeAgente) {}

  /** Se llama al empezar cada turno, para no arrastrar lo del turno anterior. */
  reiniciarTurno(): void {
    this.clasificacion = null;
    this.redacciones = [];
    this.correcciones = [];
  }

  para(contexto: ContextoDeAgente): Agente {
    const { clasificador, redactor, resumidor, llamadas } = this.real.para(contexto);

    return {
      resumidor,
      llamadas,
      clasificador: {
        clasificar: async (entrada) => {
          const resultado = await clasificador.clasificar(entrada);
          this.clasificacion = resultado;
          return resultado;
        },
      },
      redactor: {
        redactar: async (entrada) => {
          if (entrada.correccion !== undefined) this.correcciones.push(entrada.correccion);
          const resultado = await redactor.redactar(entrada);
          this.redacciones.push(resultado);
          return resultado;
        },
      },
    };
  }
}
