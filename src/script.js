import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import { Water } from './water.js';
import { Feathers } from './feathers.js';


/**
 * Settings
 */
const params = {
    windStrength: 0.6,      // m/s
    windAngle: 0,           // degrees, set below so the wind blows across the view
    turbulence: 1,
    fallSpeed: 0.38,        // m/s, terminal fall speed of a feather
    swing: 1,               // side-to-side pendulum motion
    rippleStrength: 1,
    swell: 1,
    timeScale: 1,
    spawnHeight: 7,         // m
    area: 4.5               // m, radius of the landing zone
};
const FEATHER_COUNT = 80;

// Sun position in the HDRI (measured from the brightest pixel: u = 0.606, v = 0.560).
const SUN_AZIMUTH = ( 0.6062 - 0.5 ) * Math.PI * 2;
const SUN_ELEVATION = ( 0.5601 - 0.5 ) * Math.PI;
const sunDirection = new THREE.Vector3(
    Math.cos( SUN_ELEVATION ) * Math.cos( SUN_AZIMUTH ),
    Math.sin( SUN_ELEVATION ),
    Math.cos( SUN_ELEVATION ) * Math.sin( SUN_AZIMUTH )
);
const SUN_COLOR = 0xffb27a;


/**
 * Global
 */
// scene
const scene = new THREE.Scene();

// camera: looking roughly toward the low sun, so the feathers are backlit and the water glitters
const viewAzimuth = SUN_AZIMUTH - 0.5;
const forward = new THREE.Vector3( Math.cos( viewAzimuth ), 0, Math.sin( viewAzimuth ) );
const camera = new THREE.PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.05, 3000 );
camera.position.copy( forward ).multiplyScalar( - 7.5 ).setY( 1.3 );

// wind blows across the view (camera right)
const right = new THREE.Vector3().crossVectors( forward, new THREE.Vector3( 0, 1, 0 ) );
params.windAngle = Math.round( THREE.MathUtils.radToDeg( Math.atan2( right.z, right.x ) ) );

// container
const container = document.createElement( 'div' );
document.body.appendChild( container );


// renderer
const renderer = new THREE.WebGPURenderer( { antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
await renderer.init();
container.appendChild( renderer.domElement );

renderer.inspector = new Inspector();
document.body.appendChild( renderer.inspector.domElement );

// GUI
const gui = renderer.inspector.createParameters( 'Tweaks' );


// Loaders
const hdrLoader = new HDRLoader().setPath( './textures/' );
const gltfLoader = new GLTFLoader().setPath( './models/' );

const [ sky, featherGltf ] = await Promise.all( [
    hdrLoader.loadAsync( 'sky.hdr' ),
    gltfLoader.loadAsync( 'feather.glb' )
] );

sky.mapping = THREE.EquirectangularReflectionMapping;
scene.background = sky;
scene.environment = sky;
scene.environmentIntensity = 0.9;


/**
 * Lights
 */
const sun = new THREE.DirectionalLight( SUN_COLOR, 1.6 );
sun.position.copy( sunDirection ).multiplyScalar( 20 );
scene.add( sun );


/**
 * Controls
 */
const controls = new OrbitControls( camera, renderer.domElement );
controls.target.set( 0, 1.7, 0 );
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;  // stay above the water
controls.minDistance = 1;
controls.maxDistance = 30;


/**
 * Water
 */
const water = new Water( { windAngle: params.windAngle * THREE.MathUtils.DEG2RAD } );
scene.add( water.mesh );


/**
 * Feathers
 */
let featherGeometry = null;
featherGltf.scene.traverse( ( child ) => {

    if ( child.isMesh && ! featherGeometry ) featherGeometry = child.geometry;

} );

const feathers = new Feathers( {
    geometry: featherGeometry,
    count: FEATHER_COUNT,
    water,
    params,
    sunDirection,
    sunColor: SUN_COLOR
} );
scene.add( feathers.mesh );


/**
 * GUI
 */
gui.add( params, 'windStrength', 0, 3, 0.01 ).name( 'wind strength' );
gui.add( params, 'windAngle', - 180, 180, 1 ).name( 'wind direction' );
gui.add( params, 'turbulence', 0, 2, 0.01 );
gui.add( params, 'fallSpeed', 0.1, 1.2, 0.01 ).name( 'fall speed' );
gui.add( params, 'swing', 0, 2, 0.01 );
gui.add( params, 'rippleStrength', 0, 3, 0.01 ).name( 'ripple strength' );
gui.add( params, 'swell', 0, 3, 0.01 );
gui.add( params, 'timeScale', 0, 2, 0.01 ).name( 'time scale' );


/**
 * Resize
 */
window.addEventListener( 'resize', () => {

    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );

} );


/**
 * Animation
 */
const timer = new THREE.Timer();
timer.connect( document );

function tick() {

    timer.update();
    const dt = Math.min( timer.getDelta(), 1 / 30 ) * params.timeScale;
    water.time.value += dt;
    water.swellStrength.value = params.swell;

    feathers.update( dt );
    controls.update();
    renderer.render( scene, camera );

}

renderer.setAnimationLoop( tick );
