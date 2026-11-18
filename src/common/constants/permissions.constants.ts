/**
 * Códigos de permiso del sistema.
 * Los monitores reciben un set por defecto; el admin puede ampliarlos después.
 */
export const PermissionCode = {
  DASHBOARD_VER: 'dashboard.ver',
  VENTAS_VER: 'ventas.ver',
  REPORTES_VER: 'reportes.ver',
  USUARIOS_GESTIONAR: 'usuarios.gestionar',
} as const;

export type PermissionCodeType =
  (typeof PermissionCode)[keyof typeof PermissionCode];

/** Permisos que se asignan automáticamente a un MONITOR nuevo. */
export const DEFAULT_MONITOR_PERMISSIONS: PermissionCodeType[] = [
  PermissionCode.VENTAS_VER,
  PermissionCode.REPORTES_VER,
];

/** Permisos que se asignan automáticamente a un ADMIN nuevo. */
export const DEFAULT_ADMIN_PERMISSIONS: PermissionCodeType[] = [
  PermissionCode.DASHBOARD_VER,
  PermissionCode.VENTAS_VER,
  PermissionCode.REPORTES_VER,
  PermissionCode.USUARIOS_GESTIONAR,
];

/** Catálogo semilla de permisos (código + nombre legible). */
export const PERMISSION_CATALOG: Array<{
  code: PermissionCodeType;
  name: string;
  description: string;
}> = [
  {
    code: PermissionCode.DASHBOARD_VER,
    name: 'Ver indicadores',
    description:
      'Pantalla de Inicio con los gráficos de ventas. Se activa con el check del administrador',
  },
  {
    code: PermissionCode.VENTAS_VER,
    name: 'Ver ventas',
    description: 'Consulta de listados de ventas',
  },
  {
    code: PermissionCode.REPORTES_VER,
    name: 'Ver reportes',
    description: 'Consulta de reportes operativos',
  },
  {
    code: PermissionCode.USUARIOS_GESTIONAR,
    name: 'Gestionar usuarios',
    description: 'Alta y edición de vendedores y monitores',
  },
];
