declare module 'mock:icons' {
  interface ProductionIcon { id: string; label: string; svg: string; sources: string[] }
  const icons: ProductionIcon[];
  export default icons;
}
