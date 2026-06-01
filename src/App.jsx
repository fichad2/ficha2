import React, { useEffect, useMemo, useState } from "react";
import { auth, db } from "./firebase";
import appLogo from "../logo.png";
import {
  applyActionCode,
  createUserWithEmailAndPassword,
  deleteUser,
  getIdToken,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import "./index.css";

const toInputDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const startOfCurrentMonth = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
};

const endOfToday = () => new Date();
const startOfWeek = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

const endOfWeek = (date = new Date()) => {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
};

const formatDateTime = (date) => {
  if (!date) return "-";
  return date.toLocaleString();
};

const minutesToHours = (minutes) => {
  const safe = Number.isFinite(minutes) ? minutes : 0;
  return (safe / 60).toFixed(2);
};

const parseLogDate = (timestamp) => {
  if (!timestamp) return null;
  if (typeof timestamp.toDate === "function") return timestamp.toDate();
  if (typeof timestamp.seconds === "number") return new Date(timestamp.seconds * 1000);
  return null;
};

const inRange = (date, fromStr, toStr) => {
  if (!date) return false;
  if (!fromStr && !toStr) return true;

  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const from = fromStr ? new Date(`${fromStr}T00:00:00`) : null;
  const to = toStr ? new Date(`${toStr}T23:59:59`) : null;

  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
};

function AlertMessage({ type, text }) {
  if (!text) return null;
  const className =
    type === "error"
      ? "rounded-lg bg-red-100 text-red-700 px-4 py-3 text-sm break-words"
      : "rounded-lg bg-green-100 text-green-700 px-4 py-3 text-sm break-words";

  return <p className={className}>{text}</p>;
}

function BrandHeader({ title, subtitle }) {
  return (
    <div className="flex min-w-0 flex-col items-center text-center gap-2">
      <div className="grid h-12 w-12 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm sm:h-14 sm:w-14">
        <img src={appLogo} alt="Logo Fichad2" className="h-9 w-9 object-contain sm:h-10 sm:w-10" />
      </div>
      <div className="min-w-0">
        <h1 className="text-xl font-bold leading-tight text-slate-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm leading-snug text-slate-600">{subtitle}</p>}
      </div>
    </div>
  );
}

function AuthView({
  email,
  password,
  setEmail,
  setPassword,
  iniciarSesion,
  registrarse,
  crearEmpresaInicial,
  modoAltaEmpresa,
  setModoAltaEmpresa,
  datosEmpresaAlta,
  setDatosEmpresaAlta,
  busy,
  authAction,
  errorMsg,
  infoMsg,
}) {
  return (
    <div className="mx-auto w-full max-w-[420px] rounded-lg bg-white p-5 shadow-lg sm:p-8">
      <BrandHeader title="Control Horario" subtitle="Acceso seguro para tu equipo" />

      <div className="space-y-2 mt-6 mb-4">
        <AlertMessage type="error" text={errorMsg} />
        <AlertMessage type="info" text={infoMsg} />
      </div>

      <input
        className="mb-3 w-full rounded-lg border border-slate-300 p-4 text-base"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <input
        className="mb-5 w-full rounded-lg border border-slate-300 p-4 text-base"
        type="password"
        placeholder="Contrasena"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      {modoAltaEmpresa && (
        <div className="space-y-3 mb-5">
          <input
            className="w-full rounded-lg border border-slate-300 p-4 text-base"
            placeholder="Nombre empresa"
            value={datosEmpresaAlta.name}
            onChange={(e) =>
              setDatosEmpresaAlta((prev) => ({ ...prev, name: e.target.value }))
            }
          />
          <input
            className="w-full rounded-lg border border-slate-300 p-4 text-base"
            placeholder="CIF"
            value={datosEmpresaAlta.cif}
            onChange={(e) =>
              setDatosEmpresaAlta((prev) => ({ ...prev, cif: e.target.value }))
            }
          />
          <input
            className="w-full rounded-lg border border-slate-300 p-4 text-base"
            placeholder="Direccion"
            value={datosEmpresaAlta.address}
            onChange={(e) =>
              setDatosEmpresaAlta((prev) => ({ ...prev, address: e.target.value }))
            }
          />
          <input
            className="w-full rounded-lg border border-slate-300 p-4 text-base"
            placeholder="Responsable"
            value={datosEmpresaAlta.responsable}
            onChange={(e) =>
              setDatosEmpresaAlta((prev) => ({ ...prev, responsable: e.target.value }))
            }
          />
        </div>
      )}

      {!modoAltaEmpresa ? (
        <>
          <button
            className="mb-3 w-full rounded-lg bg-blue-600 p-4 text-base font-semibold text-white disabled:opacity-60"
            onClick={iniciarSesion}
            disabled={busy}
          >
            {authAction === "login" ? "Procesando..." : "Iniciar sesion"}
          </button>

          <button
            className="mb-3 w-full rounded-lg bg-green-600 p-4 text-base font-semibold text-white disabled:opacity-60"
            onClick={registrarse}
            disabled={busy}
          >
            {authAction === "register" ? "Procesando..." : "Registrarse"}
          </button>
        </>
      ) : (
        <button
          className="mb-3 w-full rounded-lg bg-indigo-600 p-4 text-base font-semibold text-white disabled:opacity-60"
          onClick={crearEmpresaInicial}
          disabled={busy}
        >
          {authAction === "company" ? "Procesando..." : "Crear empresa y admin"}
        </button>
      )}

      <button
        className="text-sm text-slate-700 underline w-full"
        onClick={() => setModoAltaEmpresa((prev) => !prev)}
        disabled={busy}
      >
        {modoAltaEmpresa ? "Volver a acceso normal" : "Soy empresa nueva: crear alta inicial"}
      </button>
    </div>
  );
}

function AdminPanel({
  stats,
  errorMsg,
  infoMsg,
  editEmpresa,
  setEditEmpresa,
  guardarEmpresa,
  nuevoEmail,
  setNuevoEmail,
  crearTrabajador,
  trabajadores,
  resumenTrabajadores,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  calcularDashboard,
  descargarPDFTrabajadores,
  descargarCSVTrabajadores,
  descargarCSVInspeccion,
  cerrarSesion,
  busy,
  weeklySummary,
  weeklyLimitHours,
  setWeeklyLimitHours,
}) {
  const resumenByUserId = useMemo(() => {
    return resumenTrabajadores.reduce((acc, item) => {
      acc[item.id] = item;
      return acc;
    }, {});
  }, [resumenTrabajadores]);

  return (
    <div className="mx-auto w-full max-w-[420px] space-y-4 pb-20 sm:max-w-2xl md:max-w-4xl lg:max-w-6xl md:pb-0">
      <BrandHeader title="Panel Administrador" subtitle="Gestion y control del equipo" />

      <div className="space-y-2">
        <AlertMessage type="error" text={errorMsg} />
        <AlertMessage type="info" text={infoMsg} />
      </div>

      <div className="space-y-3 rounded-lg bg-white p-4 shadow md:p-5">
        <h2 className="text-lg font-semibold text-gray-800 sm:text-xl">Filtro de reportes</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <input
            className="w-full rounded-lg border border-slate-300 p-3 text-base"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <input
            className="w-full rounded-lg border border-slate-300 p-3 text-base"
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
          <button
            className="w-full rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white disabled:opacity-60"
            onClick={calcularDashboard}
            disabled={busy}
          >
            {busy ? "Actualizando..." : "Aplicar filtro"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg bg-white p-4 text-center shadow md:p-5">
          <p className="text-sm text-gray-500">Trabajadores</p>
          <p className="text-2xl font-bold">{stats.totalTrabajadores}</p>
        </div>
        <div className="rounded-lg bg-white p-4 text-center shadow md:p-5">
          <p className="text-sm text-gray-500">Horas en rango</p>
          <p className="text-2xl font-bold">{stats.totalHorasMes}h</p>
        </div>
        <div className="rounded-lg bg-white p-4 text-center shadow md:p-5">
          <p className="text-sm text-gray-500">Mas activo</p>
          <p className="text-base md:text-lg font-semibold break-words">{stats.topTrabajador}</p>
        </div>
        <div className="rounded-lg bg-white p-4 text-center shadow md:p-5">
          <p className="text-sm text-gray-500">Sin fichar hoy</p>
          <p className="text-sm break-words">
            {stats.sinFicharHoy.length > 0 ? stats.sinFicharHoy.join(", ") : "Todos ficharon"}
          </p>
        </div>
      </div>

      <div className="space-y-3 rounded-lg bg-white p-4 shadow md:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-800 sm:text-xl">Control semanal de horas</h2>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Limite semanal
            <input
              className="w-20 rounded-lg border border-slate-300 p-2 text-right"
              type="number"
              min="1"
              max="80"
              step="1"
              value={weeklyLimitHours}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (!Number.isFinite(parsed)) return;
                setWeeklyLimitHours(Math.min(80, Math.max(1, Math.floor(parsed))));
              }}
            />
            h
          </label>
        </div>

        {weeklySummary.length === 0 ? (
          <p className="text-sm text-gray-500">Sin datos semanales todavia.</p>
        ) : (
          <div className="space-y-2">
            {weeklySummary.map((row) => {
              const limitMinutes = weeklyLimitHours * 60;
              const ratio = limitMinutes > 0 ? row.minutosSemana / limitMinutes : 0;
              const status =
                row.minutosSemana >= limitMinutes
                  ? "exceso"
                  : row.minutosSemana >= limitMinutes * 0.9
                    ? "riesgo"
                    : "ok";
              const statusClass =
                status === "exceso"
                  ? "bg-red-100 text-red-700"
                  : status === "riesgo"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-emerald-100 text-emerald-700";

              return (
                <div key={row.id} className="space-y-2 rounded-lg border border-slate-200 p-3">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <p className="min-w-0 text-sm font-medium break-all">{row.email || "sin email"}</p>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-xs ${statusClass}`}>
                      {minutesToHours(row.minutosSemana)}h
                    </span>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${
                        status === "exceso"
                          ? "bg-red-500"
                          : status === "riesgo"
                            ? "bg-amber-500"
                            : "bg-emerald-500"
                      }`}
                      style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-lg bg-white p-4 shadow md:p-5">
        <h2 className="text-lg font-semibold text-gray-800 sm:text-xl">Datos de empresa</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input
            className="w-full rounded-lg border border-slate-300 p-3 text-base"
            placeholder="Nombre"
            value={editEmpresa.name || ""}
            onChange={(e) => setEditEmpresa((prev) => ({ ...prev, name: e.target.value }))}
          />
          <input
            className="w-full rounded-lg border border-slate-300 p-3 text-base"
            placeholder="CIF"
            value={editEmpresa.cif || ""}
            onChange={(e) => setEditEmpresa((prev) => ({ ...prev, cif: e.target.value }))}
          />
          <input
            className="w-full rounded-lg border border-slate-300 p-3 text-base"
            placeholder="Direccion"
            value={editEmpresa.address || ""}
            onChange={(e) => setEditEmpresa((prev) => ({ ...prev, address: e.target.value }))}
          />
          <input
            className="w-full rounded-lg border border-slate-300 p-3 text-base"
            placeholder="Responsable"
            value={editEmpresa.responsable || ""}
            onChange={(e) =>
              setEditEmpresa((prev) => ({ ...prev, responsable: e.target.value }))
            }
          />
        </div>
        <button
          className="w-full rounded-lg bg-indigo-600 px-5 py-3 font-semibold text-white disabled:opacity-60 sm:w-auto"
          onClick={guardarEmpresa}
          disabled={busy}
        >
          {busy ? "Guardando..." : "Guardar empresa"}
        </button>
      </div>

      <div className="space-y-3 rounded-lg bg-white p-4 shadow md:p-5">
        <h2 className="text-lg font-semibold text-gray-800 sm:text-xl">Invitar trabajador</h2>
        <div className="flex flex-col md:flex-row gap-3">
          <input
            className="w-full min-w-0 flex-1 rounded-lg border border-slate-300 p-3 text-base"
            placeholder="Email del trabajador"
            value={nuevoEmail}
            onChange={(e) => setNuevoEmail(e.target.value)}
          />
          <button
            className="w-full rounded-lg bg-green-600 px-5 py-3 font-semibold text-white disabled:opacity-60 md:w-auto"
            onClick={crearTrabajador}
            disabled={busy}
          >
            {busy ? "Creando..." : "Crear invitacion"}
          </button>
        </div>

        <div>
          <h3 className="font-medium mb-2">Trabajadores actuales</h3>
          {trabajadores.length === 0 ? (
            <p className="text-sm text-gray-500">No hay trabajadores cargados.</p>
          ) : (
            <ul className="text-sm text-gray-700 space-y-2">
              {trabajadores.map((item) => (
                <li key={item.id} className="rounded-lg bg-slate-50 p-3">
                  <p className="break-all">{item.email}</p>
                  <p className="text-xs text-slate-600">
                    {minutesToHours(resumenByUserId[item.id]?.minutosAcumulados || 0)}h totales
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-3 rounded-lg bg-white p-4 shadow md:p-5">
        <h2 className="text-lg font-semibold text-gray-800 sm:text-xl">Resumen de horas</h2>
        {resumenTrabajadores.length === 0 ? (
          <p className="text-sm text-gray-500">Aun no hay datos de horas.</p>
        ) : (
          <>
            <div className="md:hidden space-y-2">
              {resumenTrabajadores.map((row) => (
                <div key={row.id} className="space-y-1 rounded-lg border border-slate-200 p-3">
                  <p className="text-sm font-medium break-all">{row.email || "sin email"}</p>
                  <p className="text-sm text-slate-600">
                    Horas en rango: {minutesToHours(row.minutosMes)}h
                  </p>
                  <p className="text-sm text-slate-600">
                    Horas totales: {minutesToHours(row.minutosAcumulados)}h
                  </p>
                </div>
              ))}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-4">Trabajador</th>
                    <th className="py-2 pr-4">Horas en rango</th>
                    <th className="py-2 pr-4">Horas totales</th>
                  </tr>
                </thead>
                <tbody>
                  {resumenTrabajadores.map((row) => (
                    <tr key={row.id} className="border-b">
                      <td className="py-2 pr-4 break-all">{row.email || "sin email"}</td>
                      <td className="py-2 pr-4">{minutesToHours(row.minutosMes)}h</td>
                      <td className="py-2 pr-4">{minutesToHours(row.minutosAcumulados)}h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap justify-center gap-3 pb-6">
        <button
          className="w-full rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white disabled:opacity-60 sm:w-auto"
          onClick={calcularDashboard}
          disabled={busy}
        >
          {busy ? "Actualizando..." : "Actualizar dashboard"}
        </button>
        <button
          className="w-full rounded-lg bg-slate-700 px-5 py-3 font-semibold text-white disabled:opacity-60 sm:w-auto"
          onClick={descargarPDFTrabajadores}
          disabled={busy}
        >
          Descargar PDF trabajadores
        </button>
        <button
          className="w-full rounded-lg bg-slate-500 px-5 py-3 font-semibold text-white disabled:opacity-60 sm:w-auto"
          onClick={descargarCSVTrabajadores}
          disabled={busy}
        >
          Exportar CSV
        </button>
        <button
          className="w-full rounded-lg bg-emerald-700 px-5 py-3 font-semibold text-white disabled:opacity-60 sm:w-auto"
          onClick={descargarCSVInspeccion}
          disabled={busy}
        >
          Exportar inspeccion
        </button>
        <button
          className="w-full rounded-lg bg-red-600 px-5 py-3 font-semibold text-white sm:w-auto"
          onClick={cerrarSesion}
        >
          Cerrar sesion
        </button>
      </div>
    </div>
  );
}

function WorkerPanel({
  errorMsg,
  infoMsg,
  fichar,
  cerrarSesion,
  busy,
  workerHistory,
  workerHistoryPage,
  totalHistoryPages,
  onPrevHistoryPage,
  onNextHistoryPage,
  refrescarHistorial,
  emailVerified,
  reenviarVerificacion,
  refrescarEstadoVerificacion,
}) {
  return (
    <div className="mx-auto w-full max-w-[420px] space-y-4 sm:max-w-2xl md:max-w-4xl">
      <div className="rounded-lg bg-white p-5 text-center shadow-lg sm:p-8">
        <BrandHeader title="Panel Trabajador" subtitle="Registra tu jornada en segundos" />

        <div className="space-y-2 mb-5 mt-6 text-left">
          <AlertMessage type="error" text={errorMsg} />
          <AlertMessage type="info" text={infoMsg} />
          {!emailVerified && (
            <p className="rounded bg-yellow-100 text-yellow-800 px-3 py-2 text-sm">
              Tu email no esta verificado. Verificalo para fichar.
            </p>
          )}
        </div>

        <button
          className="mx-auto mb-3 w-full max-w-xl rounded-lg bg-green-600 p-4 text-base font-semibold text-white disabled:opacity-60"
          onClick={() => fichar("entrada")}
          disabled={busy || !emailVerified}
        >
          {busy ? "Guardando..." : "Fichar entrada"}
        </button>

        <button
          className="mx-auto mb-4 w-full max-w-xl rounded-lg bg-red-600 p-4 text-base font-semibold text-white disabled:opacity-60"
          onClick={() => fichar("salida")}
          disabled={busy || !emailVerified}
        >
          {busy ? "Guardando..." : "Fichar salida"}
        </button>

        <div className="flex flex-col items-center gap-3">
          {!emailVerified && (
            <>
              <button
                className="mx-auto w-full max-w-xl rounded-lg bg-amber-600 p-4 text-base font-semibold text-white disabled:opacity-60"
                onClick={reenviarVerificacion}
                disabled={busy}
              >
                Reenviar verificacion
              </button>
              <button
                className="mx-auto w-full max-w-xl rounded-lg bg-emerald-700 p-4 text-base font-semibold text-white disabled:opacity-60"
                onClick={refrescarEstadoVerificacion}
                disabled={busy}
              >
                Ya verifique mi email
              </button>
            </>
          )}
          <button
            className="mx-auto w-full max-w-xl rounded-lg bg-blue-600 p-4 text-base font-semibold text-white disabled:opacity-60"
            onClick={refrescarHistorial}
            disabled={busy}
          >
            Actualizar historial
          </button>
          <button
            className="mx-auto w-full max-w-xl rounded-lg bg-gray-800 p-4 text-base font-semibold text-white"
            onClick={cerrarSesion}
          >
            Cerrar sesion
          </button>
        </div>
      </div>

      <div className="rounded-lg bg-white p-4 shadow">
        <h2 className="text-lg font-semibold mb-3">Historial de fichajes</h2>
        {workerHistory.length === 0 ? (
          <p className="text-sm text-gray-500">Aun no tienes fichajes registrados.</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2 md:hidden">
              {workerHistory.map((item) => (
                <div key={item.id} className="space-y-1 rounded-lg border border-slate-200 p-3 text-left">
                  <p className="text-sm font-medium text-slate-900">{formatDateTime(item.date)}</p>
                  <p className="text-sm text-slate-600">Tipo: {item.tipo}</p>
                  <p className="text-sm text-slate-600">
                    Horas de sesion:{" "}
                    {typeof item.minutosSesion === "number"
                      ? `${minutesToHours(item.minutosSesion)}h`
                      : "-"}
                  </p>
                </div>
              ))}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-4">Fecha</th>
                    <th className="py-2 pr-4">Tipo</th>
                    <th className="py-2 pr-4">Horas de sesion</th>
                  </tr>
                </thead>
                <tbody>
                  {workerHistory.map((item) => (
                    <tr key={item.id} className="border-b">
                      <td className="py-2 pr-4">{formatDateTime(item.date)}</td>
                      <td className="py-2 pr-4">{item.tipo}</td>
                      <td className="py-2 pr-4">
                        {typeof item.minutosSesion === "number"
                          ? `${minutesToHours(item.minutosSesion)}h`
                          : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between gap-3">
              <button
                className="rounded-lg bg-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                onClick={onPrevHistoryPage}
                disabled={workerHistoryPage <= 1 || busy}
              >
                Anterior
              </button>
              <span className="text-center text-sm text-gray-600">
                Pagina {workerHistoryPage} de {totalHistoryPages}
              </span>
              <button
                className="rounded-lg bg-gray-200 px-3 py-2 text-sm disabled:opacity-50"
                onClick={onNextHistoryPage}
                disabled={workerHistoryPage >= totalHistoryPages || busy}
              >
                Siguiente
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [emailVerified, setEmailVerified] = useState(false);
  const [rol, setRol] = useState(null);
  const [companyId, setCompanyId] = useState(null);
  const [modoAltaEmpresa, setModoAltaEmpresa] = useState(false);
  const [datosEmpresaAlta, setDatosEmpresaAlta] = useState({
    name: "",
    cif: "",
    address: "",
    responsable: "",
  });

  const [loadingAuth, setLoadingAuth] = useState(true);
  const [busy, setBusy] = useState(false);
  const [authAction, setAuthAction] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [infoMsg, setInfoMsg] = useState("");

  const [editEmpresa, setEditEmpresa] = useState({
    name: "",
    cif: "",
    address: "",
    responsable: "",
  });

  const [trabajadores, setTrabajadores] = useState([]);
  const [nuevoEmail, setNuevoEmail] = useState("");
  const [resumenTrabajadores, setResumenTrabajadores] = useState([]);

  const [workerHistory, setWorkerHistory] = useState([]);
  const [workerHistoryPage, setWorkerHistoryPage] = useState(1);
  const workerHistoryPageSize = 15;

  const [dateFrom, setDateFrom] = useState(toInputDate(startOfCurrentMonth()));
  const [dateTo, setDateTo] = useState(toInputDate(endOfToday()));

  const [stats, setStats] = useState({
    totalTrabajadores: 0,
    totalHorasMes: 0,
    topTrabajador: "-",
    sinFicharHoy: [],
  });
  const [weeklyLimitHours, setWeeklyLimitHours] = useState(40);
  const [weeklySummary, setWeeklySummary] = useState([]);

  const clearMessages = () => {
    setErrorMsg("");
    setInfoMsg("");
  };

  const normalizeEmail = (rawEmail) => rawEmail.trim().toLowerCase();
  const slugify = (value) =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 30);
  const generateCompanyId = (name) => {
    const slug = slugify(name || "empresa") || "empresa";
    const suffix = Date.now().toString(36).slice(-6);
    return `${slug}-${suffix}`;
  };
  const workerEmailVerified = emailVerified;
  const totalHistoryPages = Math.max(1, Math.ceil(workerHistory.length / workerHistoryPageSize));
  const pagedWorkerHistory = workerHistory.slice(
    (workerHistoryPage - 1) * workerHistoryPageSize,
    workerHistoryPage * workerHistoryPageSize
  );

  const registrarAuditoria = async (accion, detalle = {}) => {
    if (!user?.uid || !companyId) return;

    try {
      await addDoc(collection(db, "audit_logs"), {
        companyId,
        userId: user.uid,
        userEmail: user.email || null,
        role: rol || null,
        accion,
        detalle,
        createdAt: serverTimestamp(),
      });
    } catch {
      // Si falla la auditoria, no se bloquea el flujo principal.
    }
  };

  useEffect(() => {
    if (!errorMsg && !infoMsg) return;
    const timer = setTimeout(() => {
      setErrorMsg("");
      setInfoMsg("");
    }, 6000);

    return () => clearTimeout(timer);
  }, [errorMsg, infoMsg]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    const oobCode = params.get("oobCode");

    if (mode !== "verifyEmail" || !oobCode) return;

    const finalizeVerification = async () => {
      try {
        await applyActionCode(auth, oobCode);
        if (auth.currentUser) {
          await reload(auth.currentUser);
          setEmailVerified(Boolean(auth.currentUser.emailVerified));
        }
        setInfoMsg("Email verificado correctamente. Ya puedes fichar.");
      } catch (error) {
        setErrorMsg("No se pudo verificar el email: " + error.message);
      } finally {
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
      }
    };

    finalizeVerification();
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (userAuth) => {
      setUser(userAuth);
      setEmailVerified(Boolean(userAuth?.emailVerified));
      clearMessages();

      if (userAuth) {
        await cargarRol(userAuth);
      } else {
        setRol(null);
        setCompanyId(null);
        setTrabajadores([]);
        setResumenTrabajadores([]);
        setWeeklySummary([]);
        setWorkerHistory([]);
        setWorkerHistoryPage(1);
        setEmailVerified(false);
      }

      setLoadingAuth(false);
    });

    return unsub;
  }, []);

  useEffect(() => {
    if (!companyId || !rol) return;

    if (rol === "administrador") {
      cargarPanelAdministrador();
      return;
    }

    if (rol === "trabajador") {
      cargarHistorialTrabajador();
    }
  }, [rol, companyId]);

  useEffect(() => {
    if (workerHistoryPage > totalHistoryPages) {
      setWorkerHistoryPage(totalHistoryPages);
    }
  }, [workerHistoryPage, totalHistoryPages]);

  const getSortedUserLogs = async (userIdToRead) => {
    const logsQuery = query(
      collection(db, "logs"),
      where("companyId", "==", companyId),
      where("userId", "==", userIdToRead)
    );
    const logsSnap = await getDocs(logsQuery);

    return logsSnap.docs
      .map((item) => ({ id: item.id, ...item.data(), date: parseLogDate(item.data().timestamp) }))
      .filter((item) => item.date)
      .sort((a, b) => a.date - b.date);
  };

  const getOpenEntry = (logs) => {
    let openEntry = null;

    logs.forEach((log) => {
      if (log.tipo === "entrada") {
        openEntry = log;
        return;
      }

      if (log.tipo === "salida" && openEntry) {
        openEntry = null;
      }
    });

    return openEntry;
  };

  const cargarRol = async (currentUser) => {
    try {
      const snap = await getDoc(doc(db, "users", currentUser.uid));
      if (!snap.exists()) {
        setErrorMsg("Tu usuario no tiene perfil configurado. Contacta al administrador.");
        setRol(null);
        setCompanyId(null);
        await signOut(auth);
        return;
      }

      const data = snap.data();
      setRol(data.role || null);
      setCompanyId(data.companyId || null);
    } catch {
      setErrorMsg("No se pudo cargar el rol del usuario.");
      setRol(null);
      setCompanyId(null);
    }
  };

  const iniciarSesion = async () => {
    clearMessages();
    const cleanEmail = normalizeEmail(email);

    if (!cleanEmail || !password) {
      setErrorMsg("Completa email y contrasena.");
      return;
    }

    setBusy(true);
    setAuthAction("login");
    try {
      const cred = await signInWithEmailAndPassword(auth, cleanEmail, password);
      const verifiedNow = Boolean(cred.user.emailVerified);
      setEmailVerified(verifiedNow);
      if (!verifiedNow) {
        setInfoMsg("Sesion iniciada. Verifica tu email para poder fichar.");
      }
    } catch (error) {
      setErrorMsg("No se pudo iniciar sesion: " + error.message);
    } finally {
      setBusy(false);
      setAuthAction(null);
    }
  };

  const reenviarVerificacion = async () => {
    clearMessages();
    if (!auth.currentUser) return;

    setBusy(true);
    try {
      await sendEmailVerification(auth.currentUser, {
        url: window.location.origin,
      });
      setInfoMsg("Te hemos enviado un correo de verificacion.");
      await registrarAuditoria("email_verificacion_enviado");
    } catch (error) {
      setErrorMsg("No se pudo enviar verificacion: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const refrescarEstadoVerificacion = async () => {
    clearMessages();
    if (!auth.currentUser) return;

    setBusy(true);
    try {
      await reload(auth.currentUser);
      await getIdToken(auth.currentUser, true);
      const verifiedNow = Boolean(auth.currentUser.emailVerified);
      setEmailVerified(verifiedNow);
      setUser(auth.currentUser);

      if (verifiedNow) {
        setInfoMsg("Email verificado correctamente. Ya puedes fichar.");
      } else {
        setInfoMsg("Aun no aparece como verificado. Revisa tu correo y vuelve a pulsar.");
      }
    } catch (error) {
      setErrorMsg("No se pudo actualizar el estado de verificacion: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const registrarse = async () => {
    clearMessages();
    const cleanEmail = normalizeEmail(email);

    if (!cleanEmail || password.length < 6) {
      setErrorMsg("Introduce un email valido y una contrasena de al menos 6 caracteres.");
      return;
    }

    setBusy(true);
    setAuthAction("register");
    try {
      const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      const invitacionRef = doc(db, "invitations", cleanEmail);
      let invitacionSnap = await getDoc(invitacionRef);
      let invitacionToDeleteRef = invitacionRef;

      if (!invitacionSnap.exists()) {
        const legacyQuery = query(
          collection(db, "invitations"),
          where("email", "==", cleanEmail)
        );
        const legacySnap = await getDocs(legacyQuery);
        if (!legacySnap.empty) {
          invitacionSnap = legacySnap.docs[0];
          invitacionToDeleteRef = doc(db, "invitations", legacySnap.docs[0].id);
        }
      }

      if (!invitacionSnap.exists()) {
        await deleteUser(cred.user);
        setErrorMsg("No tienes invitacion para registrarte.");
        return;
      }

      const dataInv = invitacionSnap.data();

      await setDoc(doc(db, "users", cred.user.uid), {
        email: cleanEmail,
        role: dataInv.role,
        companyId: dataInv.companyId,
        createdAt: serverTimestamp(),
      });

      await deleteDoc(invitacionToDeleteRef);
      setInfoMsg("Registro completado correctamente.");
      setEmail("");
      setPassword("");
    } catch (error) {
      setErrorMsg("Error en registro: " + error.message);
    } finally {
      setBusy(false);
      setAuthAction(null);
    }
  };

  const crearEmpresaInicial = async () => {
    clearMessages();

    const cleanEmail = normalizeEmail(email);
    const cleanName = (datosEmpresaAlta.name || "").trim();

    if (!cleanEmail || password.length < 6) {
      setErrorMsg("Introduce un email valido y una contrasena de al menos 6 caracteres.");
      return;
    }

    if (!cleanName) {
      setErrorMsg("Introduce el nombre de la empresa.");
      return;
    }

    setBusy(true);
    setAuthAction("company");
    try {
      const cred = await createUserWithEmailAndPassword(auth, cleanEmail, password);
      const newCompanyId = generateCompanyId(cleanName);

      await setDoc(doc(db, "companies", newCompanyId), {
        name: cleanName,
        cif: (datosEmpresaAlta.cif || "").trim(),
        address: (datosEmpresaAlta.address || "").trim(),
        responsable: (datosEmpresaAlta.responsable || "").trim(),
        ownerUid: cred.user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await setDoc(doc(db, "users", cred.user.uid), {
        email: cleanEmail,
        role: "administrador",
        companyId: newCompanyId,
        createdAt: serverTimestamp(),
      });

      await sendEmailVerification(cred.user, {
        url: window.location.origin,
      });

      setModoAltaEmpresa(false);
      setDatosEmpresaAlta({
        name: "",
        cif: "",
        address: "",
        responsable: "",
      });
      setInfoMsg(
        "Empresa creada. Revisa tu correo para verificar email y luego accede como administrador."
      );
    } catch (error) {
      setErrorMsg("No se pudo crear la empresa: " + error.message);
    } finally {
      setBusy(false);
      setAuthAction(null);
    }
  };

  const cargarEmpresa = async () => {
    try {
      const snap = await getDoc(doc(db, "companies", companyId));
      if (snap.exists()) {
        setEditEmpresa(snap.data());
      }
    } catch {
      setErrorMsg("No se pudo cargar la empresa.");
    }
  };

  const guardarEmpresa = async () => {
    clearMessages();
    setBusy(true);
    try {
      await updateDoc(doc(db, "companies", companyId), {
        name: editEmpresa.name || "",
        cif: editEmpresa.cif || "",
        address: editEmpresa.address || "",
        responsable: editEmpresa.responsable || "",
        updatedAt: serverTimestamp(),
      });
      await registrarAuditoria("empresa_actualizada");
      setInfoMsg("Empresa actualizada.");
    } catch (error) {
      setErrorMsg("No se pudo actualizar la empresa: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const cargarTrabajadores = async () => {
    const q = query(
      collection(db, "users"),
      where("companyId", "==", companyId),
      where("role", "==", "trabajador")
    );
    const snapshot = await getDocs(q);

    const workers = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }));

    setTrabajadores(workers);
    return workers;
  };

  const crearTrabajador = async () => {
    clearMessages();
    const cleanEmail = normalizeEmail(nuevoEmail);

    if (!cleanEmail || !cleanEmail.includes("@")) {
      setErrorMsg("Introduce un email valido para crear la invitacion.");
      return;
    }

    setBusy(true);
    try {
      await setDoc(doc(db, "invitations", cleanEmail), {
        email: cleanEmail,
        companyId,
        role: "trabajador",
        createdBy: user?.uid || null,
        createdByEmail: user?.email || null,
        createdAt: serverTimestamp(),
      });

      await registrarAuditoria("invitacion_creada", { invitadoEmail: cleanEmail });

      setNuevoEmail("");
      setInfoMsg("Invitacion creada correctamente.");
    } catch (error) {
      setErrorMsg("Error al crear invitacion: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const guardarSalidaYHoras = async () => {
    const logs = await getSortedUserLogs(user.uid);
    const ultimaEntradaAbierta = getOpenEntry(logs);

    if (!ultimaEntradaAbierta) {
      throw new Error("No tienes una entrada abierta. Primero ficha entrada.");
    }

    const inicio = ultimaEntradaAbierta.date;
    const fin = new Date();

    if (!inicio || fin <= inicio) {
      throw new Error("No se pudo calcular la duracion de la jornada.");
    }

    const minutosSesion = Math.floor((fin - inicio) / (1000 * 60));

    await addDoc(collection(db, "logs"), {
      userId: user.uid,
      companyId,
      tipo: "salida",
      minutosSesion,
      entradaLogId: ultimaEntradaAbierta.id,
      inicioSesion: inicio,
      timestamp: serverTimestamp(),
    });

    return minutosSesion;
  };

  const fichar = async (tipo) => {
    clearMessages();

    if (!user || !companyId) {
      setErrorMsg("No se pudo fichar: falta informacion de usuario o empresa.");
      return;
    }
    if (!workerEmailVerified) {
      try {
        await reload(auth.currentUser);
        const verifiedNow = Boolean(auth.currentUser?.emailVerified);
        setEmailVerified(verifiedNow);
      } catch {
        // Si falla el refresh, se mantiene la validacion actual.
      }
    }
    if (!Boolean(auth.currentUser?.emailVerified)) {
      setErrorMsg("Debes verificar tu email antes de fichar.");
      return;
    }

    setBusy(true);
    try {
      const logs = await getSortedUserLogs(user.uid);
      const hasOpenEntry = Boolean(getOpenEntry(logs));

      if (tipo === "entrada") {
        if (hasOpenEntry) {
          throw new Error("Ya tienes una entrada abierta. Debes fichar salida primero.");
        }

        await addDoc(collection(db, "logs"), {
          userId: user.uid,
          companyId,
          tipo: "entrada",
          timestamp: serverTimestamp(),
        });

        await registrarAuditoria("fichaje_entrada");
        setInfoMsg("Entrada registrada correctamente.");
      } else {
        if (!hasOpenEntry) {
          throw new Error("No hay una entrada abierta para cerrar.");
        }

        const minutosSesion = await guardarSalidaYHoras();
        await registrarAuditoria("fichaje_salida", { minutosSesion });
        setInfoMsg(`Salida registrada. Jornada guardada: ${minutesToHours(minutosSesion)}h.`);
      }

      if (rol === "administrador") {
        await cargarPanelAdministrador();
      } else {
        await cargarHistorialTrabajador();
      }
    } catch (error) {
      setErrorMsg("Error al fichar: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const buildDashboardFromData = (workers, allLogs) => {
    const hoyString = new Date().toLocaleDateString();
    const weekStart = startOfWeek();
    const weekEnd = endOfWeek();

    let totalMinutosRango = 0;
    const minutosRangoPorTrabajador = {};
    const minutosAcumuladosPorTrabajador = {};
    const minutosSemanaPorTrabajador = {};
    const fichajesHoy = {};
    const logsByUser = {};

    allLogs
      .filter((item) => item.userId && item.date)
      .forEach((item) => {
        if (!logsByUser[item.userId]) logsByUser[item.userId] = [];
        logsByUser[item.userId].push(item);
      });

    Object.entries(logsByUser).forEach(([userId, userLogs]) => {
      const ordered = userLogs.sort((a, b) => a.date - b.date);
      let entradaPendiente = null;

      ordered.forEach((log) => {
        if (log.date.toLocaleDateString() === hoyString) {
          fichajesHoy[userId] = true;
        }

        if (log.tipo === "salida" && typeof log.minutosSesion === "number") {
          minutosAcumuladosPorTrabajador[userId] =
            (minutosAcumuladosPorTrabajador[userId] || 0) + log.minutosSesion;

          if (log.date >= weekStart && log.date <= weekEnd) {
            minutosSemanaPorTrabajador[userId] =
              (minutosSemanaPorTrabajador[userId] || 0) + log.minutosSesion;
          }

          if (inRange(log.date, dateFrom, dateTo)) {
            totalMinutosRango += log.minutosSesion;
            minutosRangoPorTrabajador[userId] =
              (minutosRangoPorTrabajador[userId] || 0) + log.minutosSesion;
          }

          entradaPendiente = null;
          return;
        }

        if (log.tipo === "entrada") {
          entradaPendiente = log.date;
          return;
        }

        if (log.tipo === "salida" && entradaPendiente && log.date > entradaPendiente) {
          const mins = Math.floor((log.date - entradaPendiente) / (1000 * 60));
          minutosAcumuladosPorTrabajador[userId] =
            (minutosAcumuladosPorTrabajador[userId] || 0) + mins;

          if (log.date >= weekStart && log.date <= weekEnd) {
            minutosSemanaPorTrabajador[userId] = (minutosSemanaPorTrabajador[userId] || 0) + mins;
          }

          if (inRange(log.date, dateFrom, dateTo)) {
            totalMinutosRango += mins;
            minutosRangoPorTrabajador[userId] = (minutosRangoPorTrabajador[userId] || 0) + mins;
          }

          entradaPendiente = null;
        }
      });
    });

    let topId = null;
    let maxMin = 0;

    Object.entries(minutosRangoPorTrabajador).forEach(([uid, mins]) => {
      if (mins > maxMin) {
        maxMin = mins;
        topId = uid;
      }
    });

    const topTrabajador = workers.find((item) => item.id === topId);
    const sinFicharHoy = workers.filter((item) => !fichajesHoy[item.id]);

    const resumen = workers.map((item) => ({
      id: item.id,
      email: item.email,
      minutosMes: minutosRangoPorTrabajador[item.id] || 0,
      minutosAcumulados: minutosAcumuladosPorTrabajador[item.id] || 0,
    }));
    const resumenSemanal = workers
      .map((item) => ({
        id: item.id,
        email: item.email,
        minutosSemana: minutosSemanaPorTrabajador[item.id] || 0,
      }))
      .sort((a, b) => b.minutosSemana - a.minutosSemana);

    setResumenTrabajadores(resumen);
    setWeeklySummary(resumenSemanal);
    setStats({
      totalTrabajadores: workers.length,
      totalHorasMes: Math.floor(totalMinutosRango / 60),
      topTrabajador: topTrabajador ? topTrabajador.email : "-",
      sinFicharHoy: sinFicharHoy.map((item) => item.email),
    });
  };

  const calcularDashboard = async () => {
    clearMessages();
    setBusy(true);
    try {
      const workers = await cargarTrabajadores();
      const logsQuery = query(collection(db, "logs"), where("companyId", "==", companyId));
      const logsSnap = await getDocs(logsQuery);
      const logs = logsSnap.docs
        .map((item) => ({ ...item.data(), date: parseLogDate(item.data().timestamp) }))
        .filter((item) => item.date);

      buildDashboardFromData(workers, logs);
      setInfoMsg("Dashboard actualizado.");
    } catch (error) {
      setErrorMsg("No se pudo calcular el dashboard: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const cargarHistorialTrabajador = async () => {
    if (!user?.uid || !companyId) return;

    setBusy(true);
    try {
      const logs = await getSortedUserLogs(user.uid);
      const latestFirst = [...logs].reverse();
      setWorkerHistory(latestFirst);
      setWorkerHistoryPage(1);
    } catch (error) {
      setErrorMsg("No se pudo cargar el historial: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const cargarPanelAdministrador = async () => {
    setBusy(true);
    try {
      await cargarEmpresa();
      await calcularDashboard();
    } finally {
      setBusy(false);
    }
  };

  const buildReportRows = () => {
    if (resumenTrabajadores.length > 0) return resumenTrabajadores;
    return trabajadores.map((item) => ({
      id: item.id,
      email: item.email,
      minutosMes: 0,
      minutosAcumulados: 0,
    }));
  };

  const csvEscape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;

  const formatExportDateTime = (date) => {
    if (!date) return "";
    return date.toISOString();
  };

  const getWorkerName = (worker) => worker?.name || worker?.displayName || "No disponible";

  const getSessionMinutes = (entrada, salida) => {
    if (typeof salida?.minutosSesion === "number") return salida.minutosSesion;
    if (entrada?.date && salida?.date && salida.date > entrada.date) {
      return Math.floor((salida.date - entrada.date) / (1000 * 60));
    }
    return null;
  };

  const buildInspectionRows = (workers, logs, companyData) => {
    const rows = [];
    const workersById = workers.reduce((acc, worker) => {
      acc[worker.id] = worker;
      return acc;
    }, {});
    const logsByUser = {};

    logs
      .filter((item) => item.userId && item.date)
      .forEach((item) => {
        if (!logsByUser[item.userId]) logsByUser[item.userId] = [];
        logsByUser[item.userId].push(item);
      });

    Object.entries(logsByUser).forEach(([userId, userLogs]) => {
      const worker = workersById[userId] || { id: userId };
      const ordered = userLogs.sort((a, b) => a.date - b.date);
      const entradasById = new Map(
        ordered.filter((log) => log.tipo === "entrada").map((log) => [log.id, log])
      );
      const entradasPendientes = [];
      const usedEntradaIds = new Set();

      ordered.forEach((log) => {
        if (log.tipo === "entrada") {
          entradasPendientes.push(log);
          return;
        }

        if (log.tipo !== "salida") return;

        let entrada = log.entradaLogId ? entradasById.get(log.entradaLogId) : null;
        if (!entrada) {
          entrada = entradasPendientes.find((item) => !usedEntradaIds.has(item.id)) || null;
        }
        if (entrada) usedEntradaIds.add(entrada.id);

        rows.push({ worker, entrada, salida: log });
      });

      entradasPendientes
        .filter((entrada) => !usedEntradaIds.has(entrada.id))
        .forEach((entrada) => rows.push({ worker, entrada, salida: null }));
    });

    const filteredRows = rows.filter(({ entrada, salida }) => (
      (entrada?.date && inRange(entrada.date, dateFrom, dateTo))
      || (salida?.date && inRange(salida.date, dateFrom, dateTo))
    ));
    const finalRows = filteredRows.length > 0
      ? filteredRows
      : workers.map((worker) => ({ worker, entrada: null, salida: null }));
    const totalPeriodMinutes = finalRows.reduce((sum, row) => {
      const minutes = getSessionMinutes(row.entrada, row.salida);
      return sum + (typeof minutes === "number" ? minutes : 0);
    }, 0);
    const generatedAt = new Date().toISOString();

    return finalRows.map(({ worker, entrada, salida }) => {
      const sessionMinutes = getSessionMinutes(entrada, salida);
      return {
        companyName: companyData.name || "No disponible",
        companyCif: companyData.cif || "No disponible",
        companyAddress: companyData.address || "No disponible",
        companyResponsible: companyData.responsable || "No disponible",
        workerName: getWorkerName(worker),
        workerEmail: worker.email || "No disponible",
        workerId: worker.id || "No disponible",
        dateFrom: dateFrom || "inicio",
        dateTo: dateTo || "hoy",
        generatedAt,
        entradaTimestamp: formatExportDateTime(entrada?.date),
        salidaTimestamp: formatExportDateTime(salida?.date),
        sessionMinutes: typeof sessionMinutes === "number" ? sessionMinutes : "",
        sessionHours: typeof sessionMinutes === "number" ? minutesToHours(sessionMinutes) : "",
        totalPeriodHours: minutesToHours(totalPeriodMinutes),
        entradaLogId: entrada?.id || "",
        salidaLogId: salida?.id || "",
        entradaLogIdPairing: salida?.entradaLogId || "",
      };
    });
  };

  const descargarPDFTrabajadores = async () => {
    clearMessages();

    try {
      const rows = buildReportRows();
      if (rows.length === 0) {
        setErrorMsg("No hay trabajadores para exportar.");
        return;
      }

      const jsPdfModule = await import("jspdf");
      const docPdf = new jsPdfModule.jsPDF();

      const empresa = editEmpresa.name || "Empresa";
      const fecha = new Date().toLocaleString();
      let y = 20;

      docPdf.setFontSize(14);
      docPdf.text(`Reporte de trabajadores - ${empresa}`, 14, y);
      y += 8;
      docPdf.setFontSize(10);
      docPdf.text(`Rango: ${dateFrom || "inicio"} a ${dateTo || "hoy"}`, 14, y);
      y += 6;
      docPdf.text(`Generado: ${fecha}`, 14, y);
      y += 12;

      docPdf.setFontSize(11);
      docPdf.text("Email", 14, y);
      docPdf.text("Horas rango", 120, y);
      docPdf.text("Horas totales", 165, y);
      y += 6;

      rows.forEach((row, index) => {
        if (y > 280) {
          docPdf.addPage();
          y = 20;
        }

        docPdf.setFontSize(10);
        docPdf.text(`${index + 1}. ${row.email || "sin email"}`, 14, y);
        docPdf.text(minutesToHours(row.minutosMes), 124, y);
        docPdf.text(minutesToHours(row.minutosAcumulados), 172, y);
        y += 6;
      });

      docPdf.save(`reporte_trabajadores_${Date.now()}.pdf`);
      await registrarAuditoria("export_pdf", { dateFrom, dateTo, totalFilas: rows.length });
      setInfoMsg("PDF generado y descargado.");
    } catch (error) {
      setErrorMsg("No se pudo generar el PDF: " + error.message);
    }
  };

  const descargarCSVTrabajadores = () => {
    clearMessages();
    const rows = buildReportRows();

    if (rows.length === 0) {
      setErrorMsg("No hay trabajadores para exportar.");
      return;
    }

    const header = ["email", "horas_rango", "horas_totales"];
    const body = rows.map((row) => [
      row.email || "",
      minutesToHours(row.minutosMes),
      minutesToHours(row.minutosAcumulados),
    ]);

    const csvContent = [header, ...body]
      .map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.setAttribute("download", `reporte_trabajadores_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setInfoMsg("CSV exportado correctamente.");
    registrarAuditoria("export_csv", { dateFrom, dateTo, totalFilas: rows.length });
  };

  const descargarCSVInspeccion = async () => {
    clearMessages();
    setBusy(true);

    try {
      const workers = trabajadores.length > 0 ? trabajadores : await cargarTrabajadores();
      const companySnap = await getDoc(doc(db, "companies", companyId));
      const companyData = companySnap.exists() ? companySnap.data() : editEmpresa;
      const logsQuery = query(collection(db, "logs"), where("companyId", "==", companyId));
      const logsSnap = await getDocs(logsQuery);
      const logs = logsSnap.docs
        .map((item) => ({ id: item.id, ...item.data(), date: parseLogDate(item.data().timestamp) }))
        .filter((item) => item.date);
      const rows = buildInspectionRows(workers, logs, companyData || {});

      if (rows.length === 0) {
        setErrorMsg("No hay datos para exportar.");
        return;
      }

      const header = [
        "company_name",
        "company_cif",
        "company_address",
        "company_responsible",
        "worker_name",
        "worker_email",
        "worker_id",
        "date_from",
        "date_to",
        "generated_at",
        "entrada_timestamp",
        "salida_timestamp",
        "session_minutes",
        "session_hours",
        "total_period_hours",
        "entrada_log_id",
        "salida_log_id",
        "entrada_log_id_pairing",
      ];
      const body = rows.map((row) => [
        row.companyName,
        row.companyCif,
        row.companyAddress,
        row.companyResponsible,
        row.workerName,
        row.workerEmail,
        row.workerId,
        row.dateFrom,
        row.dateTo,
        row.generatedAt,
        row.entradaTimestamp,
        row.salidaTimestamp,
        row.sessionMinutes,
        row.sessionHours,
        row.totalPeriodHours,
        row.entradaLogId,
        row.salidaLogId,
        row.entradaLogIdPairing,
      ]);
      const csvContent = [header, ...body]
        .map((line) => line.map(csvEscape).join(","))
        .join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = url;
      link.setAttribute("download", `inspeccion_laboral_${Date.now()}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      await registrarAuditoria("export_inspeccion_csv", {
        dateFrom,
        dateTo,
        totalFilas: rows.length,
      });
      setInfoMsg("Exportacion de inspeccion generada correctamente.");
    } catch (error) {
      setErrorMsg("No se pudo generar la exportacion de inspeccion: " + error.message);
    } finally {
      setBusy(false);
    }
  };

  const cerrarSesion = async () => {
    await signOut(auth);
  };

  const onPrevHistoryPage = () => {
    setWorkerHistoryPage((prev) => Math.max(1, prev - 1));
  };

  const onNextHistoryPage = () => {
    setWorkerHistoryPage((prev) => Math.min(totalHistoryPages, prev + 1));
  };

  if (loadingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4 sm:p-6">
        <p className="text-gray-700">Cargando sesion...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-gradient-to-b from-blue-50 to-slate-100 px-4 py-5 sm:px-6 md:p-8">
      {!user ? (
        <div className="flex min-h-[calc(100vh-2.5rem)] items-center justify-center">
          <AuthView
            email={email}
            password={password}
            setEmail={setEmail}
            setPassword={setPassword}
            iniciarSesion={iniciarSesion}
            registrarse={registrarse}
            crearEmpresaInicial={crearEmpresaInicial}
            modoAltaEmpresa={modoAltaEmpresa}
            setModoAltaEmpresa={setModoAltaEmpresa}
            datosEmpresaAlta={datosEmpresaAlta}
            setDatosEmpresaAlta={setDatosEmpresaAlta}
            busy={busy}
            authAction={authAction}
            errorMsg={errorMsg}
            infoMsg={infoMsg}
          />
        </div>
      ) : rol === "administrador" ? (
        <AdminPanel
          stats={stats}
          errorMsg={errorMsg}
          infoMsg={infoMsg}
          editEmpresa={editEmpresa}
          setEditEmpresa={setEditEmpresa}
          guardarEmpresa={guardarEmpresa}
          nuevoEmail={nuevoEmail}
          setNuevoEmail={setNuevoEmail}
          crearTrabajador={crearTrabajador}
          trabajadores={trabajadores}
          resumenTrabajadores={resumenTrabajadores}
          dateFrom={dateFrom}
          setDateFrom={setDateFrom}
          dateTo={dateTo}
          setDateTo={setDateTo}
          calcularDashboard={calcularDashboard}
          descargarPDFTrabajadores={descargarPDFTrabajadores}
          descargarCSVTrabajadores={descargarCSVTrabajadores}
          descargarCSVInspeccion={descargarCSVInspeccion}
          cerrarSesion={cerrarSesion}
          busy={busy}
          weeklySummary={weeklySummary}
          weeklyLimitHours={weeklyLimitHours}
          setWeeklyLimitHours={setWeeklyLimitHours}
        />
      ) : (
        <div className="flex min-h-[calc(100vh-2.5rem)] flex-col justify-center">
          <WorkerPanel
            errorMsg={errorMsg}
            infoMsg={infoMsg}
            fichar={fichar}
            cerrarSesion={cerrarSesion}
            busy={busy}
            workerHistory={pagedWorkerHistory}
            workerHistoryPage={workerHistoryPage}
            totalHistoryPages={totalHistoryPages}
            onPrevHistoryPage={onPrevHistoryPage}
            onNextHistoryPage={onNextHistoryPage}
          refrescarHistorial={cargarHistorialTrabajador}
          emailVerified={workerEmailVerified}
          reenviarVerificacion={reenviarVerificacion}
          refrescarEstadoVerificacion={refrescarEstadoVerificacion}
        />
      </div>
    )}
    </div>
  );
}

export default App;
