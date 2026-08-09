# Contexto operativo del bar Mercedes

Esto se le pasa a los tres agentes de informes en CADA corrida, como parte de su
prompt de sistema. Son cosas que ya sabemos y que cambian cómo hay que leer los
números. Sin esto, el agente las "descubre" cada semana y las presenta como
hallazgos.

Se puede editar sin tocar código: el archivo se lee en cada corrida. Lo carga
`contextoOperativo()` en `src/informes.js`.

Qué va acá y qué no:

- **Acá:** hechos duraderos del negocio que hacen que un número raro no sea raro.
- **No acá:** feedback puntual sobre un hallazgo — eso va como nota desde la app
  (hoja `Informes Notas`), lo escriben los dueños y queda firmado.
- **No acá:** cómo se comporta la app (que una pestaña se crea sola, que un botón
  hace tal cosa). Eso no cambia la lectura de ningún número y sólo gasta atención.

---

## Estructura de la plata

**`Mercado Pago Pablo` no es un pozo limpio de recupero: es una cuenta de uso
diario, por decisión tomada el 8/8/2026.** Pablo paga gastos del bar desde ahí
—carne, verdura, un sueldo— y va a seguir haciéndolo. Ver salidas de esa cuenta
hacia proveedores es lo esperado, no una fuga.

**Las propinas digitales no entran al libro.** Se reparten aparte, entre `Galicia`
y `Brubank`. Consecuencia conocida y aceptada: mientras hay propinas sin repartir,
el saldo real del banco Galicia corre por encima de su Saldo Calculado, exactamente
por ese monto. No es un descuadre.

**Mantenimiento tampoco escribe en el libro.** Anotar "hay que cambiar el
extractor" no es haber gastado la plata. Si un arreglo termina siendo una
inversión real, se carga a mano en Plan de Inversiones.

**Si falta la comisión de Galicia en una fila de tarjeta**, significa que actuó
el freno del 50% durante el cierre y quedó para cargar a mano. Es un dato
faltante conocido, no un cobro que no existió.

## Personal

**Desde julio de 2026 son 4 empleados más Pablo trabajando: 5 sueldos.** Antes
eran 2. Todo lo que dependa de la dotación —cargas sociales, VEP de ARCA,
sueldos, la categoría Personal— está en un nivel nuevo y más alto de forma
permanente. Puede que entre más personal todavía.

## Diferencias conocidas que ya se investigaron

**~$190.000 de ingresos de Mercado Pago de junio de 2026 no cuadran** entre el
total mensual y el detalle diario. Se buscó la causa y no se encontró; queda para
el contador. No hace falta volver a levantarlo como hallazgo.

## Series que todavía son cortas

**El stock de bebidas se viene fotografiando desde principios de julio de 2026.**
Cualquier comparación contra "lo habitual" en esa serie tiene poca historia
detrás: conviene decirlo cuando se use, en vez de presentarla como una tendencia
firme.

## Una trampa de la planilla

**El libro está en locale US.** Una fecha tipeada `3/8/26` se guarda internamente
como 8 de enero. La app lee el texto que se muestra y vuelve a interpretarlo bien,
así que los números que llegan a un informe son correctos. Pero las fechas
guardadas dentro de la planilla están mal: no sirve razonar sobre el orden
cronológico crudo de la hoja.
