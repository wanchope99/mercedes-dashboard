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
- **No acá:** lo que alguna planilla ya puede afirmar sola. Lo que sabe la nómina
  lo dice la nómina, con fecha y sin desactualizarse. Este archivo guarda lo que
  no está en ninguna planilla.

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

**La dotación y el costo laboral ya NO se escriben acá.** Desde el 17/8/2026 los
informes reciben un bloque generado desde la nómina (`src/nomina.js`) con cuánta
gente hay, cuánto cuesta el mes y en qué meses se paga el aguinaldo. Si hace
falta corregir eso, se corrige la planilla de nómina, no este archivo.

Lo que sí vive acá, porque no está en ninguna planilla:

**Durante 2026 crecieron las dos cosas a la vez: entró gente y además se
registraron más empleados en blanco.** Por eso las cargas sociales y el VEP de
ARCA subieron más de lo que explicaría sólo la cantidad de personas. Puede que
entre más personal todavía.

**Las cargas sociales se cargan dentro de la categoría Personal, no en
Fiscales.** Medido contra el libro el 17/8/2026: en Fiscales sólo hay ARCA por
$137.949 en mayo y $65.535 en junio, contra $1,64M mensuales de cargas reales.
Así que el gasto de Personal del libro incluye sueldos y cargas juntos.

## Qué días abre

**Mercedes abre de martes a sábado. Domingo y lunes está cerrado**, y por lo
tanto un domingo o un lunes sin ventas, sin pedidos y sin producción es lo
esperado — nunca un hallazgo ni algo que falte cargar. Son 5 días de servicio
por semana, unos 21 al mes.

Esto vive en `src/calendario.js` y de ahí lo leen los informes, la campanita y
el resto: si alguna vez cambian los días, se cambia ahí y no en seis lados.

## Proveedores: cambiar de proveedor es una decisión, no una anomalía

**Los dueños saben a quién le compran y a quién dejaron de comprarle.** Que un
proveedor deje de aparecer en el libro no es un hallazgo: fue una decisión que
tomaron ellos. Los casos testigo son Ichiban y El Criollo, señalados el 16/8/2026
como ejemplo de lo que NO hay que informar. Lo único que aporta valor es el
resultado de ese cambio, medido: qué pasó con el costo por unidad de lo que
compraban, con el gasto semanal de esa categoría y con la frecuencia de entrega.

## Costos mensuales: sólo se juzgan con el mes cerrado

**Sueldos y cargas, alquiler, servicios e impuestos se pagan una vez por mes.**
En una semana suelta, o aparecen enteros o no aparecen, y las dos cosas son el
calendario, no información. Decir un día 16 que "falta cargar los costos de
personal" no aporta nada: el cargo todavía no ocurrió. Estos costos se analizan
únicamente en el balance mensual, concepto por concepto, y ahí sí corresponde
avisar si alguno subió de nivel o si parece faltar una carga.

## El horario que informa Fudo no sirve para analizar

**La "apertura" de un día en Fudo es cuándo se abrió la PRIMERA MESA, no cuándo
abrió el bar**, y los timestamps vienen en UTC mientras todo el resto del
análisis razona en hora argentina. Una mesa cargada a las 15:30 movía la apertura
tres horas. Además, y por encima de todo: el horario hoy no es una decisión que
esté en discusión. Los informes ya no reciben ese dato y no hay que pedirlo ni
razonar sobre él.

## Días que no fueron un servicio normal

**El 25 de mayo de 2026 se armó un turno puntual para el evento de esa fecha.**
Cayó lunes, el día que el bar no abre, y no se repite. Está excluido de todos los
análisis por código (`src/informes-excepciones.js`): no se compara nada contra
él, no se lo cuenta como día cerrado y no se lo menciona. Si aparece nombrado en
un informe anterior, es un informe viejo — no vuelve a levantarse.

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
