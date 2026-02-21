import React, { useState, useEffect } from "react";
import { auth, db } from "./firebase";
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
} from "firebase/auth";
import {
  collection,
  addDoc,
  serverTimestamp,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
} from "firebase/firestore";
import "./index.css";

function App() {

  // ==================== ESTADOS ====================
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [rol, setRol] = useState(null);
  const [companyId, setCompanyId] = useState(null);

  const [editEmpresa, setEditEmpresa] = useState({
    name: "",
    cif: "",
    address: "",
    responsable: "",
  });

  const [trabajadores, setTrabajadores] = useState([]);
  const [nuevoEmail, setNuevoEmail] = useState("");

  const [stats, setStats] = useState({
    totalTrabajadores: 0,
    totalHorasMes: 0,
    topTrabajador: "—",
    sinFicharHoy: [],
  });

  // ==================== AUTH ====================
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (userAuth) => {
      setUser(userAuth);
      if (userAuth) await cargarRol(userAuth);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (rol === "administrador" && companyId) {
      cargarEmpresa();
      cargarTrabajadores();
      calcularDashboard();
    }
  }, [rol, companyId]);

  // ==================== REGISTRO CON INVITACIÓN ====================
  const registrarse = async () => {
    try {
      const cred = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      const q = query(
        collection(db, "invitations"),
        where("email", "==", email)
      );

      const snapshot = await getDocs(q);

      if (snapshot.empty) {
        alert("No tienes invitación para registrarte.");
        await signOut(auth);
        return;
      }

      const invitacion = snapshot.docs[0];
      const dataInv = invitacion.data();

      await setDoc(doc(db, "users", cred.user.uid), {
        email: email,
        role: dataInv.role,
        companyId: dataInv.companyId,
        createdAt: new Date(),
      });

      await deleteDoc(doc(db, "invitations", invitacion.id));

      alert("Registro completado correctamente");

    } catch (error) {
      alert("Error en registro: " + error.message);
    }
  };

  // ==================== ROL ====================
  const cargarRol = async (currentUser) => {
    const snap = await getDoc(doc(db, "users", currentUser.uid));
    if (snap.exists()) {
      const data = snap.data();
      setRol(data.role);
      setCompanyId(data.companyId);
    }
  };

  // ==================== EMPRESA ====================
  const cargarEmpresa = async () => {
    const snap = await getDoc(doc(db, "companies", companyId));
    if (snap.exists()) {
      setEditEmpresa(snap.data());
    }
  };

  const guardarEmpresa = async () => {
    await updateDoc(doc(db, "companies", companyId), {
      name: editEmpresa.name || "",
      cif: editEmpresa.cif || "",
      address: editEmpresa.address || "",
      responsable: editEmpresa.responsable || "",
    });
    alert("Empresa actualizada");
  };

  // ==================== TRABAJADORES ====================
  const cargarTrabajadores = async () => {
    const q = query(
      collection(db, "users"),
      where("companyId", "==", companyId),
      where("role", "==", "trabajador")
    );
    const snapshot = await getDocs(q);

    setTrabajadores(
      snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }))
    );
  };

  const crearTrabajador = async () => {
    try {
      await addDoc(collection(db, "invitations"), {
        email: nuevoEmail,
        companyId: companyId,
        role: "trabajador",
        createdAt: new Date(),
      });

      setNuevoEmail("");
      alert("Invitación creada correctamente");

    } catch (error) {
      alert("Error al crear invitación: " + error.message);
    }
  };

  // ==================== FICHAJE ====================
  const fichar = async (tipo) => {
    try {
      await addDoc(collection(db, "logs"), {
        userId: user.uid,
        companyId: companyId,
        tipo,
        timestamp: serverTimestamp(),
      });

      alert("Fichaje registrado correctamente");
    } catch (error) {
      alert("Error al fichar: " + error.message);
    }
  };

  // ==================== DASHBOARD ====================
  const calcularDashboard = async () => {

    const usersQuery = query(
      collection(db, "users"),
      where("companyId", "==", companyId),
      where("role", "==", "trabajador")
    );

    const usersSnap = await getDocs(usersQuery);
    const trabajadoresEmpresa = usersSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const logsQuery = query(
      collection(db, "logs"),
      where("companyId", "==", companyId)
    );

    const logsSnap = await getDocs(logsQuery);
    const logs = logsSnap.docs.map(doc => doc.data());

    const ahora = new Date();
    const mesActual = ahora.getMonth();
    const añoActual = ahora.getFullYear();
    const hoyString = ahora.toLocaleDateString();

    let totalMinutosMes = 0;
    const horasPorTrabajador = {};
    const fichajesHoy = {};

    const ordenados = logs
      .filter(l => l.timestamp?.seconds)
      .sort((a,b)=>a.timestamp.seconds - b.timestamp.seconds);

    for (let i = 0; i < ordenados.length - 1; i++) {
      if (
        ordenados[i].tipo === "entrada" &&
        ordenados[i + 1].tipo === "salida"
      ) {
        const entrada = new Date(ordenados[i].timestamp.seconds * 1000);
        const salida = new Date(ordenados[i + 1].timestamp.seconds * 1000);

        const fechaStr = entrada.toLocaleDateString();

        if (fechaStr === hoyString) {
          fichajesHoy[ordenados[i].userId] = true;
        }

        if (
          entrada.getMonth() === mesActual &&
          entrada.getFullYear() === añoActual
        ) {
          const minutos = Math.floor((salida - entrada) / (1000 * 60));
          totalMinutosMes += minutos;

          if (!horasPorTrabajador[ordenados[i].userId]) {
            horasPorTrabajador[ordenados[i].userId] = 0;
          }
          horasPorTrabajador[ordenados[i].userId] += minutos;
        }
      }
    }

    let topId = null;
    let maxMin = 0;

    Object.entries(horasPorTrabajador).forEach(([uid, minutos]) => {
      if (minutos > maxMin) {
        maxMin = minutos;
        topId = uid;
      }
    });

    const topTrabajador = trabajadoresEmpresa.find(t => t.id === topId);

    const sinFicharHoy = trabajadoresEmpresa.filter(
      t => !fichajesHoy[t.id]
    );

    setStats({
      totalTrabajadores: trabajadoresEmpresa.length,
      totalHorasMes: Math.floor(totalMinutosMes / 60),
      topTrabajador: topTrabajador ? topTrabajador.email : "—",
      sinFicharHoy: sinFicharHoy.map(t => t.email),
    });
  };

  // ==================== UI ====================
  return (
    <div className="min-h-screen bg-gray-100 p-6">

      {!user ? (
        <div className="max-w-sm mx-auto bg-white p-6 rounded shadow">
          <h2 className="text-xl mb-4">Acceso</h2>

          <input
            className="border w-full mb-2 p-2"
            placeholder="Email"
            onChange={(e) => setEmail(e.target.value)}
          />

          <input
            className="border w-full mb-4 p-2"
            type="password"
            placeholder="Contraseña"
            onChange={(e) => setPassword(e.target.value)}
          />

          <button
            className="bg-blue-600 text-white w-full p-2 rounded mb-2"
            onClick={() =>
              signInWithEmailAndPassword(auth, email, password)
            }
          >
            Iniciar sesión
          </button>

          <button
            className="bg-green-600 text-white w-full p-2 rounded"
            onClick={registrarse}
          >
            Registrarse
          </button>
        </div>

      ) : rol === "administrador" ? (

        <div className="max-w-5xl mx-auto space-y-6">

          <h1 className="text-3xl font-bold text-blue-800">
            Panel Administrador
          </h1>

          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded shadow text-center">
              <p className="text-sm text-gray-500">Trabajadores</p>
              <p className="text-2xl font-bold">{stats.totalTrabajadores}</p>
            </div>
            <div className="bg-white p-4 rounded shadow text-center">
              <p className="text-sm text-gray-500">Horas este mes</p>
              <p className="text-2xl font-bold">{stats.totalHorasMes}h</p>
            </div>
            <div className="bg-white p-4 rounded shadow text-center">
              <p className="text-sm text-gray-500">Más activo</p>
              <p className="text-lg font-semibold">{stats.topTrabajador}</p>
            </div>
            <div className="bg-white p-4 rounded shadow text-center">
              <p className="text-sm text-gray-500">Sin fichar hoy</p>
              <p className="text-sm">
                {stats.sinFicharHoy.length > 0
                  ? stats.sinFicharHoy.join(", ")
                  : "Todos ficharon"}
              </p>
            </div>
          </div>

          <button
            className="bg-red-600 text-white px-4 py-2 rounded"
            onClick={() => signOut(auth)}
          >
            Cerrar sesión
          </button>
        </div>

      ) : (

        <div className="max-w-md mx-auto bg-white p-8 rounded shadow text-center">
          <h1 className="text-2xl font-bold mb-6 text-green-700">
            Panel Trabajador
          </h1>

          <button
            className="bg-green-600 text-white w-full p-3 rounded mb-3"
            onClick={() => fichar("entrada")}
          >
            Fichar Entrada
          </button>

          <button
            className="bg-red-600 text-white w-full p-3 rounded mb-3"
            onClick={() => fichar("salida")}
          >
            Fichar Salida
          </button>

          <button
            className="bg-gray-800 text-white w-full p-3 rounded"
            onClick={() => signOut(auth)}
          >
            Cerrar sesión
          </button>
        </div>

      )}
    </div>
  );
}

export default App;