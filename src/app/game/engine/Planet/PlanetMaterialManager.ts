import * as BABYLON from 'babylonjs'
import { TextureBuilder } from './TextureBuilder'
import { ColorGradientFactory } from './ColorGradientFactory'
import { NoiseSettings, PlanetOptions } from './types'
import { convolute } from '../convolute'
const backgroundWorker = require('worker-loader!./TextureBuilder.worker')


const hashStringToInt = (s: string) => {
  return s.split("").reduce(function (a, b) { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0);
}

/**
 * Planet Material Manager instantiates and manages raw BABYLON material
 * objects. It handles procedural texture generation using web workers
 * and swaps textures with higher resolution ones once they become
 * available
 *
 * @example
 *   const matManager = new PlanetMaterialManager(...myArgs)
 *
 *   myMesh.material = matManager.raw // asynchronously swaps textures when higher res are available
 *   myAtmosphereMesh.material = matManager.rawAtmosphere
 */
class PlanetMaterialManager {
  name: string
  options: PlanetOptions
  scene: BABYLON.Scene
  _noiseSettings: NoiseSettings
  _raw: BABYLON.StandardMaterial
  _rawAtmosphere: BABYLON.StandardMaterial
  heightMap: BABYLON.DynamicTexture
  diffuseMap: BABYLON.DynamicTexture
  specularMap: BABYLON.DynamicTexture
  bumpMap: BABYLON.DynamicTexture

  constructor(name: string = 'planetTexture', options: PlanetOptions, scene: BABYLON.Scene) {
    this.name = name
    this.scene = scene
    this.options = options
    this._noiseSettings = [
      { "shift": 5, "passes": 14, "strength": 0.65, "roughness": 2.1 - this.options.landMassSize * 0.02, "resistance": 0.6, "min": options.seaLevel * 0.01, "hard": true }
    ]

    if (options.roughness > 1) {
      this._noiseSettings.unshift({ shift: 18, passes: 15, strength: 0.45, roughness: 0.3, resistance: 0.65, min: options.seaLevel * 0.01, hard: true })
    }
    if (options.roughness > 2) {
      this._noiseSettings.unshift({ shift: 0, passes: 10, strength: 0.8, roughness: 0.6, resistance: 0.70, min: options.seaLevel * 0.01, hard: true })
    }
  }

  get raw(): BABYLON.StandardMaterial {
    if (!this._raw) {
      this.generateMaterial(this.scene)
    }

    return this._raw
  }

  get rawAtmosphere(): BABYLON.StandardMaterial {
    if (!this._rawAtmosphere) {
      this.generateAtmosphere(this.scene)
    }

    return this._rawAtmosphere
  }

  set noiseSettings(value: NoiseSettings) {
    if (this._raw) {
      const oldRawMaterial = this._raw
      setTimeout(() => oldRawMaterial.dispose(true, true), 2000)
      this.bumpMap.dispose()
      this.bumpMap = undefined
    }
    this._noiseSettings = value
    this.generateMaterial(this.scene)
  }

  get noiseSettings(): NoiseSettings {
    return this._noiseSettings
  }

  dispose() {
    if (this._raw) {
      this.heightMap.dispose()
      this._rawAtmosphere.dispose(true, true)
      setTimeout(() => this._raw.dispose(true, true), 5000)
    }
  }

  /**
   * New procedural material generation
   */
  protected generateMaterial(scene): BABYLON.Material {
    this._raw = new BABYLON.StandardMaterial(this.name, scene);
    this._raw.wireframe = true // hide ugly textureless sphere

    this.generateBaseTextures(256).then(() => {
      this._raw.diffuseTexture = this.diffuseMap
      this._raw.specularTexture = this.specularMap
      this._raw.bumpTexture = this.bumpMap
      this._raw.bumpTexture.level = 0.2
      this._raw.wireframe = false

      this.generateBaseTextures(512).then(() => {
        this._raw.diffuseTexture.dispose()
        this._raw.specularTexture.dispose()
        this._raw.bumpTexture.dispose()

        this._raw.diffuseTexture = this.diffuseMap
        this._raw.specularTexture = this.specularMap
        this._raw.bumpTexture = this.bumpMap
        this._raw.bumpTexture.level = this.options.roughness > 0 ? 0.45 : 0.05

        this.generateBaseTextures(1024).then(() => {
          this._raw.diffuseTexture.dispose()
          this._raw.specularTexture.dispose()
          this._raw.bumpTexture.dispose()


          this._raw.diffuseTexture = this.diffuseMap
          this._raw.specularTexture = this.specularMap
          this._raw.bumpTexture = this.bumpMap
          this._raw.bumpTexture.level = this.options.roughness > 0 ? 0.45 : 0.05
        }).catch((e) => console.error(e))
      })
    })

    this._raw.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
    this._raw.specularPower = 14

    return this._raw
  }

  protected generateAtmosphere(scene): BABYLON.Material {
    const atmosphereColors = {
      blue: new BABYLON.Color3(0.1, 0.3, 0.5),
      orange: new BABYLON.Color3(0.5, 0.4, 0.2),
      white: new BABYLON.Color3(0.3, 0.3, 0.4),
      green: new BABYLON.Color3(0.2, 0.3, 0.17),
      purple: new BABYLON.Color3(0.45, 0.2, 0.45)
    }

    this._rawAtmosphere = new BABYLON.StandardMaterial(`${this.name}Atmosphere`, scene);
    this._rawAtmosphere.reflectionTexture = new BABYLON.Texture("assets/textures/atmosphere.png", scene);
    this._rawAtmosphere.diffuseTexture = new BABYLON.Texture("assets/textures/planetClouds1.jpg", scene);
    this._rawAtmosphere.diffuseTexture.level = Math.min(this.options.atmosphereDensity, 1.2)
    this._rawAtmosphere.reflectionTexture.coordinatesMode = BABYLON.Texture.SPHERICAL_MODE;
    this._rawAtmosphere.alpha = (this.options.atmosphereDensity + 1) * 0.15
    if (this.options.atmosphereDensity > 1 && ['orange', 'green'].includes(this.options.atmosphereColor)) {
      this._rawAtmosphere.alphaMode = BABYLON.Engine.ALPHA_MAXIMIZED
    } else {
      this._rawAtmosphere.alphaMode = BABYLON.Engine.ALPHA_ADD
    }
    this._rawAtmosphere.specularPower = 2.5
    this._rawAtmosphere.zOffset = -5
    this._rawAtmosphere.specularColor = atmosphereColors[this.options.atmosphereColor]
    if (this.options.atmosphereColor === 'green') {
      this._rawAtmosphere.diffuseColor = this._rawAtmosphere.specularColor.scale(1.7)
    }
    if (this.options.atmosphereDensity >= 3) {
      this._rawAtmosphere.specularColor = this._rawAtmosphere.specularColor.scale(1.7)
    }

    return this._rawAtmosphere
  }

  async generateBaseTextures(resolution: number) {
    const oldHeightMap = this.heightMap

    this.heightMap = new BABYLON.DynamicTexture("planetHeightMap", resolution, this.scene, true)
    this.specularMap = new BABYLON.DynamicTexture("planetSpecularMap", resolution, this.scene, true)
    this.diffuseMap = new BABYLON.DynamicTexture("planetDiffuseMap", resolution, this.scene, true)

    const heightMapCtx = this.heightMap.getContext();
    const specularMapCtx = this.specularMap.getContext();
    const diffuseMapCtx = this.diffuseMap.getContext();

    const colorGradient = ColorGradientFactory.generateGradient(hashStringToInt(this.options.terrainSeed))

    const sphereNormalTexture = new Image();
    sphereNormalTexture.src = `assets/textures/planetObjectSpaceNormal.png`;
    await new Promise<void>((resolve) => {
      sphereNormalTexture.onload = () => resolve()
    })

    heightMapCtx.drawImage(sphereNormalTexture as CanvasImageSource, 0, 0, resolution, resolution)
    const heightMapImage = heightMapCtx.getImageData(0, 0, resolution, resolution)

    specularMapCtx.fillStyle = 'rgb(0,0,0)'
    specularMapCtx.fillRect(0, 0, resolution, resolution)
    const specularMapImage = specularMapCtx.getImageData(0, 0, resolution, resolution)

    const gradient = diffuseMapCtx.createLinearGradient(0,0,255,0)
    for (const color of colorGradient) {
      gradient.addColorStop(color.a / 255, `rgb(${color.r},${color.g},${color.b})`)
    }
    diffuseMapCtx.fillStyle = gradient;
    diffuseMapCtx.fillRect(0, 0, 256, 5);
    const diffuseMapImage = diffuseMapCtx.getImageData(0, 0, resolution, resolution)

    const { heightDataResult, specularDataResult, diffuseDataResult } = await TextureBuilder.buildTextures(hashStringToInt(this.options.terrainSeed), this._noiseSettings, heightMapImage, specularMapImage, diffuseMapImage)
  
    heightMapCtx.putImageData(heightMapImage, 0, 0);
    specularMapCtx.putImageData(specularMapImage, 0, 0);
    diffuseMapCtx.putImageData(diffuseMapImage, 0, 0);
    this.heightMap.update();
    this.specularMap.update();
    this.diffuseMap.update();

    console.time('generateNormalMap')
    this.bumpMap = this.generateNormalMap(heightMapImage, resolution)
    console.timeEnd('generateNormalMap')

    if (oldHeightMap) {
      setTimeout(() => oldHeightMap.dispose(), 2000)
    }
  }

  generateNormalMap(heightMapImage: ImageData, resolution: number): BABYLON.DynamicTexture {
    const TEX_RES = resolution
    let oldBumpMap: BABYLON.DynamicTexture

    if (this.bumpMap) {
      oldBumpMap = this.bumpMap
    }
    this.bumpMap = new BABYLON.DynamicTexture("planetBumpMap", resolution, this.scene, true)

    const bumpCtx = this.bumpMap.getContext()
    bumpCtx.fillStyle = 'rgb(128,128,255)'
    bumpCtx.fillRect(0, 0, TEX_RES, TEX_RES)
    if (oldBumpMap) {
      bumpCtx.drawImage((oldBumpMap.getContext().canvas as any), 0, 0, TEX_RES, TEX_RES)
    }
    const bumpImageData = bumpCtx.getImageData(0, 0, TEX_RES, TEX_RES)

    convolute(
      heightMapImage,
      bumpImageData,
      [-1, 0, 1,
      -2, 0, 2,
      -1, 0, 1],
      1,
      ['r']
    )

    convolute(
      heightMapImage,
      bumpImageData,
      [1, 2, 1,
        0, 0, 0,
        -1, -2, -1],
      1,
      ['g']
    )

    bumpCtx.putImageData(bumpImageData, 0, 0)

    this.bumpMap.update();
    return this.bumpMap
  }
}

export { PlanetMaterialManager }
