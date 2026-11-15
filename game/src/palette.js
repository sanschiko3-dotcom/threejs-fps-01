// BLACKWATER DOCK palette: a night container terminal. One sodium-orange accent
// against deep blue-black night, cold concrete, and painted steel containers.
// Every colour a mesh uses comes from this file, so the look stays coherent.
export const PALETTE = {
  canvas: '#0a0e16', // night sky and fog
  water: '#05080f', // harbour water beyond the west quay
  surface: '#1a2230', // asphalt yard
  concrete: '#2e3742', // quay walls, warehouse shell
  hairline: '#2a3442', // dark steel trim
  ink: '#e8e6df', // warm white: HUD text, lamp glow
  muted: '#8b98a8', // cool grey-blue: secondary text, distant steel
  accent: '#ff9a2e', // sodium floodlight orange: the one accent
  crane: '#c77f2a', // gantry crane safety yellow-orange
  rust: '#8a4a32', // container red-brown
  teal: '#2e6b6b', // container teal
  ochre: '#b98a2e', // container ochre
  slate: '#3d5a73', // container slate blue
  moss: '#3f5a3a', // container dark green
  grey: '#6a6f75', // container grey
  jackal: '#c96a2e', // attacker team tint (burnt orange)
  sentinel: '#3d7ab8', // defender team tint (harbour blue)
};

// Container paint jobs cycle through these so the yard reads as stacked freight.
export const CONTAINER_COLORS = ['rust', 'teal', 'ochre', 'slate', 'moss', 'grey'];
