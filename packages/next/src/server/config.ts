import { existsSync } from 'fs'
import { basename, extname, join, relative, isAbsolute, resolve } from 'path'
import { pathToFileURL } from 'url'
import findUp from 'next/dist/compiled/find-up'
import chalk from '../lib/chalk'
import * as Log from '../build/output/log'
import { CONFIG_FILES, PHASE_DEVELOPMENT_SERVER } from '../shared/lib/constants'
// import { execOnce } from '../shared/lib/utils'
import {
  defaultConfig,
  normalizeConfig,
  ExperimentalConfig,
  NextConfigComplete,
  validateConfig,
  NextConfig,
} from './config-shared'
import { loadWebpackHook } from './config-utils'
import { ImageConfig, imageConfigDefault } from '../shared/lib/image-config'
import { loadEnvConfig, updateInitialEnv } from '@next/env'
import { flushAndExit } from '../telemetry/flush-and-exit'
import { findRootDir } from '../lib/find-root'
import { setHttpClientAndAgentOptions } from './setup-http-agent-env'

export { DomainLocale, NextConfig, normalizeConfig } from './config-shared'

// const experimentalWarning = execOnce((features: string[]) => {
//   const s = features.length > 1 ? 's' : ''
//   Log.bootstrap(
//     `- Experimental feature${s} (use at your own risk): ` +
//       chalk.bold(`${features.join(', ')}`)
//   )
// })

export function warnOptionHasBeenMovedOutOfExperimental(
  config: NextConfig,
  oldKey: string,
  newKey: string,
  configFileName: string,
  silent = false
) {
  if (config.experimental && oldKey in config.experimental) {
    if (!silent) {
      Log.warn(
        `\`${oldKey}\` has been moved out of \`experimental\`` +
          (newKey.includes('.') ? ` and into \`${newKey}\`` : '') +
          `. Please update your ${configFileName} file accordingly.`
      )
    }

    let current = config
    const newKeys = newKey.split('.')
    while (newKeys.length > 1) {
      const key = newKeys.shift()!
      current[key] = current[key] || {}
      current = current[key]
    }
    current[newKeys.shift()!] = (config.experimental as any)[oldKey]
  }

  return config
}

function assignDefaults(
  dir: string,
  userConfig: { [key: string]: any },
  silent = false
) {
  const configFileName = userConfig.configFileName
  if (!silent && typeof userConfig.exportTrailingSlash !== 'undefined') {
    console.warn(
      chalk.yellow.bold('Warning: ') +
        `The "exportTrailingSlash" option has been renamed to "trailingSlash". Please update your ${configFileName}.`
    )
    if (typeof userConfig.trailingSlash === 'undefined') {
      userConfig.trailingSlash = userConfig.exportTrailingSlash
    }
    delete userConfig.exportTrailingSlash
  }

  const config = Object.keys(userConfig).reduce<{ [key: string]: any }>(
    (currentConfig, key) => {
      const value = userConfig[key]

      if (value === undefined || value === null) {
        return currentConfig
      }

      if (key === 'experimental' && typeof value === 'object') {
        const enabledExperiments: (keyof ExperimentalConfig)[] = []

        // defaultConfig.experimental is predefined and will never be undefined
        // This is only a type guard for the typescript
        if (defaultConfig.experimental) {
          for (const featureName of Object.keys(
            value
          ) as (keyof ExperimentalConfig)[]) {
            if (
              value[featureName] !== defaultConfig.experimental[featureName]
            ) {
              enabledExperiments.push(featureName)
            }
          }
        }

        // if (!silent && enabledExperiments.length > 0) {
        //   experimentalWarning(enabledExperiments)
        // }
      }

      if (key === 'distDir') {
        if (typeof value !== 'string') {
          throw new Error(
            `Specified distDir is not a string, found type "${typeof value}"`
          )
        }
        const userDistDir = value.trim()

        // don't allow public as the distDir as this is a reserved folder for
        // public files
        if (userDistDir === 'public') {
          throw new Error(
            `The 'public' directory is reserved in Next.js and can not be set as the 'distDir'. https://nextjs.org/docs/messages/can-not-output-to-public`
          )
        }
        // make sure distDir isn't an empty string as it can result in the provided
        // directory being deleted in development mode
        if (userDistDir.length === 0) {
          throw new Error(
            `Invalid distDir provided, distDir can not be an empty string. Please remove this config or set it to undefined`
          )
        }
      }

      if (key === 'pageExtensions') {
        if (!Array.isArray(value)) {
          throw new Error(
            `Specified pageExtensions is not an array of strings, found "${value}". Please update this config or remove it.`
          )
        }

        if (!value.length) {
          throw new Error(
            `Specified pageExtensions is an empty array. Please update it with the relevant extensions or remove it.`
          )
        }

        value.forEach((ext) => {
          if (typeof ext !== 'string') {
            throw new Error(
              `Specified pageExtensions is not an array of strings, found "${ext}" of type "${typeof ext}". Please update this config or remove it.`
            )
          }
        })
      }

      if (!!value && value.constructor === Object) {
        currentConfig[key] = {
          ...defaultConfig[key],
          ...Object.keys(value).reduce<any>((c, k) => {
            const v = value[k]
            if (v !== undefined && v !== null) {
              c[k] = v
            }
            return c
          }, {}),
        }
      } else {
        currentConfig[key] = value
      }

      return currentConfig
    },
    {}
  )

  const result = { ...defaultConfig, ...config }

  if (result.output === 'export') {
    if (result.i18n) {
      throw new Error(
        'Specified "i18n" cannot be used with "output: export". See more info here: https://nextjs.org/docs/messages/export-no-i18n'
      )
    }
    if (result.rewrites) {
      throw new Error(
        'Specified "rewrites" cannot be used with "output: export". See more info here: https://nextjs.org/docs/messages/export-no-custom-routes'
      )
    }
    if (result.redirects) {
      throw new Error(
        'Specified "redirects" cannot be used with "output: export". See more info here: https://nextjs.org/docs/messages/export-no-custom-routes'
      )
    }
    if (result.headers) {
      throw new Error(
        'Specified "headers" cannot be used with "output: export". See more info here: https://nextjs.org/docs/messages/export-no-custom-routes'
      )
    }
  }

  if (typeof result.assetPrefix !== 'string') {
    throw new Error(
      `Specified assetPrefix is not a string, found type "${typeof result.assetPrefix}" https://nextjs.org/docs/messages/invalid-assetprefix`
    )
  }

  if (typeof result.basePath !== 'string') {
    throw new Error(
      `Specified basePath is not a string, found type "${typeof result.basePath}"`
    )
  }

  // TODO: remove after next minor (current v13.1.1)
  if (Array.isArray(result.experimental?.outputFileTracingIgnores)) {
    if (!result.experimental) {
      result.experimental = {}
    }
    if (!result.experimental.outputFileTracingExcludes) {
      result.experimental.outputFileTracingExcludes = {}
    }
    if (!result.experimental.outputFileTracingExcludes['**/*']) {
      result.experimental.outputFileTracingExcludes['**/*'] = []
    }
    result.experimental.outputFileTracingExcludes['**/*'].push(
      ...(result.experimental.outputFileTracingIgnores || [])
    )
    Log.warn(
      `\`outputFileTracingIgnores\` has been moved to \`experimental.outputFileTracingExcludes\`. Please update your ${configFileName} file accordingly.`
    )
  }

  if (result.basePath !== '') {
    if (result.basePath === '/') {
      throw new Error(
        `Specified basePath /. basePath has to be either an empty string or a path prefix"`
      )
    }

    if (!result.basePath.startsWith('/')) {
      throw new Error(
        `Specified basePath has to start with a /, found "${result.basePath}"`
      )
    }

    if (result.basePath !== '/') {
      if (result.basePath.endsWith('/')) {
        throw new Error(
          `Specified basePath should not end with /, found "${result.basePath}"`
        )
      }

      if (result.assetPrefix === '') {
        result.assetPrefix = result.basePath
      }

      if (result.amp?.canonicalBase === '') {
        result.amp.canonicalBase = result.basePath
      }
    }
  }

  if (result?.images) {
    const images: ImageConfig = result.images

    if (typeof images !== 'object') {
      throw new Error(
        `Specified images should be an object received ${typeof images}.\nSee more info here: https://nextjs.org/docs/messages/invalid-images-config`
      )
    }

    if (images.domains) {
      if (!Array.isArray(images.domains)) {
        throw new Error(
          `Specified images.domains should be an Array received ${typeof images.domains}.\nSee more info here: https://nextjs.org/docs/messages/invalid-images-config`
        )
      }

      // static images are automatically prefixed with assetPrefix
      // so we need to ensure _next/image allows downloading from
      // this resource
      if (config.assetPrefix?.startsWith('http')) {
        images.domains.push(new URL(config.assetPrefix).hostname)
      }
    }

    if (!images.loader) {
      images.loader = 'default'
    }

    if (
      images.loader !== 'default' &&
      images.loader !== 'custom' &&
      images.path === imageConfigDefault.path
    ) {
      throw new Error(
        `Specified images.loader property (${images.loader}) also requires images.path property to be assigned to a URL prefix.\nSee more info here: https://nextjs.org/docs/api-reference/next/legacy/image#loader-configuration`
      )
    }

    if (images.path === imageConfigDefault.path && result.basePath) {
      images.path = `${result.basePath}${images.path}`
    }

    // Append trailing slash for non-default loaders and when trailingSlash is set
    if (images.path) {
      if (
        (images.loader !== 'default' &&
          images.path[images.path.length - 1] !== '/') ||
        result.trailingSlash
      ) {
        images.path += '/'
      }
    }

    if (images.loaderFile) {
      if (images.loader !== 'default' && images.loader !== 'custom') {
        throw new Error(
          `Specified images.loader property (${images.loader}) cannot be used with images.loaderFile property. Please set images.loader to "custom".`
        )
      }
      const absolutePath = join(dir, images.loaderFile)
      if (!existsSync(absolutePath)) {
        throw new Error(
          `Specified images.loaderFile does not exist at "${absolutePath}".`
        )
      }
      images.loaderFile = absolutePath
    }
  }

  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'relay',
    'compiler.relay',
    configFileName,
    silent
  )
  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'styledComponents',
    'compiler.styledComponents',
    configFileName,
    silent
  )
  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'emotion',
    'compiler.emotion',
    configFileName,
    silent
  )
  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'reactRemoveProperties',
    'compiler.reactRemoveProperties',
    configFileName,
    silent
  )
  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'removeConsole',
    'compiler.removeConsole',
    configFileName,
    silent
  )

  if (typeof result.experimental?.swcMinifyDebugOptions !== 'undefined') {
    if (!silent) {
      Log.warn(
        'SWC minify debug option is not supported anymore, please remove it from your config.'
      )
    }
  }

  if ((result.experimental as any).outputStandalone) {
    if (!silent) {
      Log.warn(
        `experimental.outputStandalone has been renamed to "output: 'standalone'", please move the config.`
      )
    }
    result.output = 'standalone'
  }

  if (typeof result.experimental?.serverActionsBodySizeLimit !== 'undefined') {
    const value = parseInt(
      result.experimental.serverActionsBodySizeLimit.toString()
    )
    if (isNaN(value) || value < 1) {
      throw new Error(
        'Server Actions Size Limit must be a valid number or filesize format lager than 1MB: https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions'
      )
    }
  }

  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'transpilePackages',
    'transpilePackages',
    configFileName,
    silent
  )
  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'skipMiddlewareUrlNormalize',
    'skipMiddlewareUrlNormalize',
    configFileName,
    silent
  )
  warnOptionHasBeenMovedOutOfExperimental(
    result,
    'skipTrailingSlashRedirect',
    'skipTrailingSlashRedirect',
    configFileName,
    silent
  )

  if (
    typeof userConfig.experimental?.clientRouterFilter === 'undefined' &&
    result.experimental?.appDir
  ) {
    result.experimental.clientRouterFilter = true
  }

  if (
    result.experimental?.outputFileTracingRoot &&
    !isAbsolute(result.experimental.outputFileTracingRoot)
  ) {
    result.experimental.outputFileTracingRoot = resolve(
      result.experimental.outputFileTracingRoot
    )
    if (!silent) {
      Log.warn(
        `experimental.outputFileTracingRoot should be absolute, using: ${result.experimental.outputFileTracingRoot}`
      )
    }
  }

  // only leverage deploymentId
  if (result.experimental?.useDeploymentId && process.env.NEXT_DEPLOYMENT_ID) {
    if (!result.experimental) {
      result.experimental = {}
    }
    result.experimental.deploymentId = process.env.NEXT_DEPLOYMENT_ID
  }

  // use the closest lockfile as tracing root
  if (!result.experimental?.outputFileTracingRoot) {
    let rootDir = findRootDir(dir)

    if (rootDir) {
      if (!result.experimental) {
        result.experimental = {}
      }
      if (!defaultConfig.experimental) {
        defaultConfig.experimental = {}
      }
      result.experimental.outputFileTracingRoot = rootDir
      defaultConfig.experimental.outputFileTracingRoot =
        result.experimental.outputFileTracingRoot
    }
  }

  if (result.output === 'standalone' && !result.outputFileTracing) {
    if (!silent) {
      Log.warn(
        `"output: 'standalone'" requires outputFileTracing not be disabled please enable it to leverage the standalone build`
      )
    }
    result.output = undefined
  }

  setHttpClientAndAgentOptions(result || defaultConfig)

  if (result.i18n) {
    const { i18n } = result
    const i18nType = typeof i18n

    if (i18nType !== 'object') {
      throw new Error(
        `Specified i18n should be an object received ${i18nType}.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }

    if (!Array.isArray(i18n.locales)) {
      throw new Error(
        `Specified i18n.locales should be an Array received ${typeof i18n.locales}.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }

    if (i18n.locales.length > 100 && !silent) {
      Log.warn(
        `Received ${i18n.locales.length} i18n.locales items which exceeds the recommended max of 100.\nSee more info here: https://nextjs.org/docs/advanced-features/i18n-routing#how-does-this-work-with-static-generation`
      )
    }

    const defaultLocaleType = typeof i18n.defaultLocale

    if (!i18n.defaultLocale || defaultLocaleType !== 'string') {
      throw new Error(
        `Specified i18n.defaultLocale should be a string.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }

    if (typeof i18n.domains !== 'undefined' && !Array.isArray(i18n.domains)) {
      throw new Error(
        `Specified i18n.domains must be an array of domain objects e.g. [ { domain: 'example.fr', defaultLocale: 'fr', locales: ['fr'] } ] received ${typeof i18n.domains}.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }

    if (i18n.domains) {
      const invalidDomainItems = i18n.domains.filter((item) => {
        if (!item || typeof item !== 'object') return true
        if (!item.defaultLocale) return true
        if (!item.domain || typeof item.domain !== 'string') return true

        if (item.domain.includes(':')) {
          console.warn(
            `i18n domain: "${item.domain}" is invalid it should be a valid domain without protocol (https://) or port (:3000) e.g. example.vercel.sh`
          )
          return true
        }

        const defaultLocaleDuplicate = i18n.domains?.find(
          (altItem) =>
            altItem.defaultLocale === item.defaultLocale &&
            altItem.domain !== item.domain
        )

        if (!silent && defaultLocaleDuplicate) {
          console.warn(
            `Both ${item.domain} and ${defaultLocaleDuplicate.domain} configured the defaultLocale ${item.defaultLocale} but only one can. Change one item's default locale to continue`
          )
          return true
        }

        let hasInvalidLocale = false

        if (Array.isArray(item.locales)) {
          for (const locale of item.locales) {
            if (typeof locale !== 'string') hasInvalidLocale = true

            for (const domainItem of i18n.domains || []) {
              if (domainItem === item) continue
              if (domainItem.locales && domainItem.locales.includes(locale)) {
                console.warn(
                  `Both ${item.domain} and ${domainItem.domain} configured the locale (${locale}) but only one can. Remove it from one i18n.domains config to continue`
                )
                hasInvalidLocale = true
                break
              }
            }
          }
        }

        return hasInvalidLocale
      })

      if (invalidDomainItems.length > 0) {
        throw new Error(
          `Invalid i18n.domains values:\n${invalidDomainItems
            .map((item: any) => JSON.stringify(item))
            .join(
              '\n'
            )}\n\ndomains value must follow format { domain: 'example.fr', defaultLocale: 'fr', locales: ['fr'] }.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
        )
      }
    }

    if (!Array.isArray(i18n.locales)) {
      throw new Error(
        `Specified i18n.locales must be an array of locale strings e.g. ["en-US", "nl-NL"] received ${typeof i18n.locales}.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }

    const invalidLocales = i18n.locales.filter(
      (locale: any) => typeof locale !== 'string'
    )

    if (invalidLocales.length > 0) {
      throw new Error(
        `Specified i18n.locales contains invalid values (${invalidLocales
          .map(String)
          .join(
            ', '
          )}), locales must be valid locale tags provided as strings e.g. "en-US".\n` +
          `See here for list of valid language sub-tags: http://www.iana.org/assignments/language-subtag-registry/language-subtag-registry`
      )
    }

    if (!i18n.locales.includes(i18n.defaultLocale)) {
      throw new Error(
        `Specified i18n.defaultLocale should be included in i18n.locales.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }

    const normalizedLocales = new Set()
    const duplicateLocales = new Set()

    i18n.locales.forEach((locale) => {
      const localeLower = locale.toLowerCase()
      if (normalizedLocales.has(localeLower)) {
        duplicateLocales.add(locale)
      }
      normalizedLocales.add(localeLower)
    })

    if (duplicateLocales.size > 0) {
      throw new Error(
        `Specified i18n.locales contains the following duplicate locales:\n` +
          `${[...duplicateLocales].join(', ')}\n` +
          `Each locale should be listed only once.\n` +
          `See more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }

    // make sure default Locale is at the front
    i18n.locales = [
      i18n.defaultLocale,
      ...i18n.locales.filter((locale) => locale !== i18n.defaultLocale),
    ]

    const localeDetectionType = typeof i18n.localeDetection

    if (
      localeDetectionType !== 'boolean' &&
      localeDetectionType !== 'undefined'
    ) {
      throw new Error(
        `Specified i18n.localeDetection should be undefined or a boolean received ${localeDetectionType}.\nSee more info here: https://nextjs.org/docs/messages/invalid-i18n-config`
      )
    }
  }

  if (result.devIndicators?.buildActivityPosition) {
    const { buildActivityPosition } = result.devIndicators
    const allowedValues = [
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]

    if (!allowedValues.includes(buildActivityPosition)) {
      throw new Error(
        `Invalid "devIndicator.buildActivityPosition" provided, expected one of ${allowedValues.join(
          ', '
        )}, received ${buildActivityPosition}`
      )
    }
  }

  const userProvidedModularizeImports = result.modularizeImports
  // Unfortunately these packages end up re-exporting 10600 modules, for example: https://unpkg.com/browse/@mui/icons-material@5.11.16/esm/index.js.
  // Leveraging modularizeImports tremendously reduces compile times for these.
  result.modularizeImports = {
    ...(userProvidedModularizeImports || {}),
    // This is intentionally added after the user-provided modularizeImports config.
    '@mui/icons-material': {
      transform: '@mui/icons-material/{{member}}',
    },
    'date-fns': {
      transform: 'date-fns/{{member}}',
    },
    lodash: {
      transform: 'lodash/{{member}}',
    },
    'lodash-es': {
      transform: 'lodash-es/{{member}}',
    },
    'lucide-react': {
      // Note that we need to first resolve to the base path (`lucide-react`) and join the subpath,
      // instead of just resolving `lucide-react/esm/icons/{{kebabCase member}}` because this package
      // doesn't have proper `exports` fields for individual icons in its package.json.
      transform: {
        // Special aliases
        '(SortAsc|LucideSortAsc|SortAscIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/arrow-up-narrow-wide!lucide-react',
        '(SortDesc|LucideSortDesc|SortDescIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/arrow-down-wide-narrow!lucide-react',
        '(Verified|LucideVerified|VerifiedIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/badge-check!lucide-react',
        '(Slash|LucideSlash|SlashIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/ban!lucide-react',
        '(CurlyBraces|LucideCurlyBraces|CurlyBracesIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/braces!lucide-react',
        '(CircleSlashed|LucideCircleSlashed|CircleSlashedIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/circle-slash-2!lucide-react',
        '(SquareGantt|LucideSquareGantt|SquareGanttIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/gantt-chart-square!lucide-react',
        '(SquareKanbanDashed|LucideSquareKanbanDashed|SquareKanbanDashedIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/kanban-square-dashed!lucide-react',
        '(SquareKanban|LucideSquareKanban|SquareKanbanIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/kanban-square!lucide-react',
        '(Edit3|LucideEdit3|Edit3Icon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/pen-line!lucide-react',
        '(Edit|LucideEdit|EditIcon|PenBox|LucidePenBox|PenBoxIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/pen-square!lucide-react',
        '(Edit2|LucideEdit2|Edit2Icon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/pen!lucide-react',
        '(Stars|LucideStars|StarsIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/sparkles!lucide-react',
        '(TextSelection|LucideTextSelection|TextSelectionIcon)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/text-select!lucide-react',
        // General rules
        'Lucide(.*)':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/{{ kebabCase memberMatches.[1] }}!lucide-react',
        '(.*)Icon':
          'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/{{ kebabCase memberMatches.[1] }}!lucide-react',
        '*': 'modularize-import-loader?name={{ member }}&from=default&as=default&join=../esm/icons/{{ kebabCase member }}!lucide-react',
      },
    },
    '@headlessui/react': {
      transform: {
        Transition:
          'modularize-import-loader?name={{member}}&join=./components/transitions/transition!@headlessui/react',
        Tab: 'modularize-import-loader?name={{member}}&join=./components/tabs/tabs!@headlessui/react',
        '*': 'modularize-import-loader?name={{member}}&join=./components/{{ kebabCase member }}/{{ kebabCase member }}!@headlessui/react',
      },
      skipDefaultConversion: true,
    },
    '@heroicons/react/20/solid': {
      transform: '@heroicons/react/20/solid/esm/{{member}}',
    },
    '@heroicons/react/24/solid': {
      transform: '@heroicons/react/24/solid/esm/{{member}}',
    },
    '@heroicons/react/24/outline': {
      transform: '@heroicons/react/24/outline/esm/{{member}}',
    },
    ramda: {
      transform: 'ramda/es/{{member}}',
    },
    'react-bootstrap': {
      transform: {
        useAccordionButton:
          'modularize-import-loader?name=useAccordionButton&from=named&as=default!react-bootstrap/AccordionButton',
        '*': 'react-bootstrap/{{member}}',
      },
    },
    antd: {
      transform: 'antd/lib/{{kebabCase member}}',
    },
    ahooks: {
      transform: {
        createUpdateEffect:
          'modularize-import-loader?name=createUpdateEffect&from=named&as=default!ahooks/es/createUpdateEffect',
        '*': 'ahooks/es/{{member}}',
      },
    },
    '@ant-design/icons': {
      transform: {
        IconProvider:
          'modularize-import-loader?name=IconProvider&from=named&as=default!@ant-design/icons',
        createFromIconfontCN: '@ant-design/icons/es/components/IconFont',
        getTwoToneColor:
          'modularize-import-loader?name=getTwoToneColor&from=named&as=default!@ant-design/icons/es/components/twoTonePrimaryColor',
        setTwoToneColor:
          'modularize-import-loader?name=setTwoToneColor&from=named&as=default!@ant-design/icons/es/components/twoTonePrimaryColor',
        '*': '@ant-design/icons/lib/icons/{{member}}',
      },
    },
    'next/server': {
      transform: 'next/dist/server/web/exports/{{ kebabCase member }}',
    },
  }

  return result
}

export default async function loadConfig(
  phase: string,
  dir: string,
  customConfig?: object | null,
  rawConfig?: boolean,
  silent?: boolean,
  onLoadUserConfig?: (conf: NextConfig) => void
): Promise<NextConfigComplete> {
  if (!process.env.__NEXT_PRIVATE_RENDER_WORKER) {
    try {
      loadWebpackHook()
    } catch (err) {
      // this can fail in standalone mode as the files
      // aren't traced/included
      if (!process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
        throw err
      }
    }
  }

  if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
    return JSON.parse(process.env.__NEXT_PRIVATE_STANDALONE_CONFIG)
  }

  // For the render worker, we directly return the serialized config from the
  // parent worker (router worker) to avoid loading it again.
  // This is because loading the config might be expensive especiall when people
  // have Webpack plugins added.
  // Because of this change, unserializable fields like `.webpack` won't be
  // existing here but the render worker shouldn't use these as well.
  if (process.env.__NEXT_PRIVATE_RENDER_WORKER_CONFIG) {
    return JSON.parse(process.env.__NEXT_PRIVATE_RENDER_WORKER_CONFIG)
  }

  const curLog = silent
    ? {
        warn: () => {},
        info: () => {},
        error: () => {},
      }
    : Log

  loadEnvConfig(dir, phase === PHASE_DEVELOPMENT_SERVER, curLog)

  let configFileName = 'next.config.js'

  if (customConfig) {
    return assignDefaults(
      dir,
      {
        configOrigin: 'server',
        configFileName,
        ...customConfig,
      },
      silent
    ) as NextConfigComplete
  }

  const path = await findUp(CONFIG_FILES, { cwd: dir })

  // If config file was found
  if (path?.length) {
    configFileName = basename(path)
    let userConfigModule: any

    try {
      const envBefore = Object.assign({}, process.env)

      // `import()` expects url-encoded strings, so the path must be properly
      // escaped and (especially on Windows) absolute paths must pe prefixed
      // with the `file://` protocol
      if (process.env.__NEXT_TEST_MODE === 'jest') {
        // dynamic import does not currently work inside of vm which
        // jest relies on so we fall back to require for this case
        // https://github.com/nodejs/node/issues/35889
        userConfigModule = require(path)
      } else {
        userConfigModule = await import(pathToFileURL(path).href)
      }
      const newEnv: typeof process.env = {} as any

      for (const key of Object.keys(process.env)) {
        if (envBefore[key] !== process.env[key]) {
          newEnv[key] = process.env[key]
        }
      }
      updateInitialEnv(newEnv)

      if (rawConfig) {
        return userConfigModule
      }
    } catch (err) {
      curLog.error(
        `Failed to load ${configFileName}, see more info here https://nextjs.org/docs/messages/next-config-error`
      )
      throw err
    }
    const userConfig = await normalizeConfig(
      phase,
      userConfigModule.default || userConfigModule
    )

    const validateResult = validateConfig(userConfig)

    if (!silent && validateResult.errors) {
      // Only load @segment/ajv-human-errors when invalid config is detected
      const { AggregateAjvError } =
        require('next/dist/compiled/@segment/ajv-human-errors') as typeof import('next/dist/compiled/@segment/ajv-human-errors')
      const aggregatedAjvErrors = new AggregateAjvError(validateResult.errors, {
        fieldLabels: 'js',
      })

      let shouldExit = false
      let messages = [`Invalid ${configFileName} options detected: `]

      for (const error of aggregatedAjvErrors) {
        messages.push(`    ${error.message}`)
        if (error.message.startsWith('The value at .images.')) {
          shouldExit = true
        }
      }

      messages.push(
        'See more info here: https://nextjs.org/docs/messages/invalid-next-config'
      )

      if (shouldExit) {
        for (const message of messages) {
          curLog.error(message)
        }
        await flushAndExit(1)
      } else {
        for (const message of messages) {
          curLog.warn(message)
        }
      }
    }

    if (userConfig.target && userConfig.target !== 'server') {
      throw new Error(
        `The "target" property is no longer supported in ${configFileName}.\n` +
          'See more info here https://nextjs.org/docs/messages/deprecated-target-config'
      )
    }

    if (userConfig.amp?.canonicalBase) {
      const { canonicalBase } = userConfig.amp || ({} as any)
      userConfig.amp = userConfig.amp || {}
      userConfig.amp.canonicalBase =
        (canonicalBase.endsWith('/')
          ? canonicalBase.slice(0, -1)
          : canonicalBase) || ''
    }

    onLoadUserConfig?.(userConfig)
    const completeConfig = assignDefaults(
      dir,
      {
        configOrigin: relative(dir, path),
        configFile: path,
        configFileName,
        ...userConfig,
      },
      silent
    ) as NextConfigComplete
    return completeConfig
  } else {
    const configBaseName = basename(CONFIG_FILES[0], extname(CONFIG_FILES[0]))
    const nonJsPath = findUp.sync(
      [
        `${configBaseName}.jsx`,
        `${configBaseName}.ts`,
        `${configBaseName}.tsx`,
        `${configBaseName}.json`,
      ],
      { cwd: dir }
    )
    if (nonJsPath?.length) {
      throw new Error(
        `Configuring Next.js via '${basename(
          nonJsPath
        )}' is not supported. Please replace the file with 'next.config.js' or 'next.config.mjs'.`
      )
    }
  }

  // always call assignDefaults to ensure settings like
  // reactRoot can be updated correctly even with no next.config.js
  const completeConfig = assignDefaults(
    dir,
    defaultConfig,
    silent
  ) as NextConfigComplete
  completeConfig.configFileName = configFileName
  setHttpClientAndAgentOptions(completeConfig)
  return completeConfig
}
