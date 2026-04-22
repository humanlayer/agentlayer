import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import * as aws from '@pulumi/aws'
import { local } from '@pulumi/command'
import * as pulumi from '@pulumi/pulumi'

const projectRoot = import.meta.dir
const contentRoot = resolve(projectRoot, 'content')
const distDir = resolve(contentRoot, '.vitepress', 'dist')

const coreStack = new pulumi.StackReference('humanlayer/core/prod')
const validatedCertificateArn = coreStack.requireOutput('validatedCertificateArn') as pulumi.Output<string>
const hostedZoneId = coreStack.requireOutput('hostedZoneId') as pulumi.Output<string>
const domainSuffix = coreStack.requireOutput('domainSuffix') as pulumi.Output<string>

const docsBuild = new local.Command('agentlayer-docs-build', {
	create: 'bun run docs:build',
	dir: projectRoot,
	triggers: [Date.now().toString()],
})

const siteBucket = new aws.s3.Bucket('agentlayer-docs-bucket', {
	forceDestroy: true,
})

new aws.s3.BucketPublicAccessBlock('agentlayer-docs-public-access-block', {
	bucket: siteBucket.id,
	blockPublicAcls: true,
	blockPublicPolicy: true,
	ignorePublicAcls: true,
	restrictPublicBuckets: true,
})

const oac = new aws.cloudfront.OriginAccessControl('agentlayer-docs-oac', {
	name: 'agentlayer-docs-prod',
	originAccessControlOriginType: 's3',
	signingBehavior: 'always',
	signingProtocol: 'sigv4',
})

const distribution = new aws.cloudfront.Distribution('agentlayer-docs-cdn', {
	enabled: true,
	defaultRootObject: 'index.html',
	waitForDeployment: true,
	aliases: [pulumi.interpolate`agentlayer.${domainSuffix}`],
	origins: [
		{
			originId: 'docsS3Origin',
			domainName: siteBucket.bucketRegionalDomainName,
			originAccessControlId: oac.id,
		},
	],
	defaultCacheBehavior: {
		targetOriginId: 'docsS3Origin',
		viewerProtocolPolicy: 'redirect-to-https',
		allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
		cachedMethods: ['GET', 'HEAD'],
		forwardedValues: {
			queryString: false,
			cookies: { forward: 'none' },
		},
		compress: true,
		minTtl: 0,
		defaultTtl: 86400,
		maxTtl: 31536000,
	},
	customErrorResponses: [
		{
			errorCode: 403,
			responseCode: 200,
			responsePagePath: '/index.html',
			errorCachingMinTtl: 10,
		},
		{
			errorCode: 404,
			responseCode: 200,
			responsePagePath: '/index.html',
			errorCachingMinTtl: 10,
		},
	],
	viewerCertificate: {
		acmCertificateArn: validatedCertificateArn,
		sslSupportMethod: 'sni-only',
		minimumProtocolVersion: 'TLSv1.2_2021',
	},
	restrictions: {
		geoRestriction: {
			restrictionType: 'none',
		},
	},
	priceClass: 'PriceClass_100',
})

new aws.s3.BucketPolicy('agentlayer-docs-bucket-policy', {
	bucket: siteBucket.id,
	policy: pulumi.all([siteBucket.arn, distribution.arn]).apply(([bucketArn, distArn]) =>
		JSON.stringify({
			Version: '2012-10-17',
			Statement: [
				{
					Sid: 'AllowCloudFrontServicePrincipalReadOnly',
					Effect: 'Allow',
					Principal: {
						Service: 'cloudfront.amazonaws.com',
					},
					Action: 's3:GetObject',
					Resource: `${bucketArn}/*`,
					Condition: {
						StringEquals: {
							'AWS:SourceArn': distArn,
						},
					},
				},
			],
		}),
	),
})

new aws.route53.Record('agentlayer-docs-dns', {
	zoneId: hostedZoneId,
	name: pulumi.interpolate`agentlayer.${domainSuffix}`,
	type: 'A',
	aliases: [
		{
			name: distribution.domainName,
			zoneId: distribution.hostedZoneId,
			evaluateTargetHealth: false,
		},
	],
})

function getContentType(filePath: string) {
	if (filePath.endsWith('.html')) return 'text/html'
	if (filePath.endsWith('.css')) return 'text/css'
	if (filePath.endsWith('.js')) return 'application/javascript'
	if (filePath.endsWith('.json')) return 'application/json'
	if (filePath.endsWith('.svg')) return 'image/svg+xml'
	if (filePath.endsWith('.png')) return 'image/png'
	if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg'
	if (filePath.endsWith('.webp')) return 'image/webp'
	if (filePath.endsWith('.woff')) return 'font/woff'
	if (filePath.endsWith('.woff2')) return 'font/woff2'
	if (filePath.endsWith('.txt')) return 'text/plain'
	return 'application/octet-stream'
}

function walk(dir: string): string[] {
	const files: string[] = []
	for (const entry of readdirSync(dir)) {
		const filePath = join(dir, entry)
		const stat = statSync(filePath)
		if (stat.isDirectory()) {
			files.push(...walk(filePath))
		} else {
			files.push(filePath)
		}
	}
	return files
}

docsBuild.stdout.apply(() => {
	for (const filePath of walk(distDir)) {
		const key = relative(distDir, filePath)
		new aws.s3.BucketObjectv2(`agentlayer-docs-${key}`, {
			bucket: siteBucket.id,
			key,
			source: new pulumi.asset.FileAsset(filePath),
			contentType: getContentType(filePath),
		})
	}
})

new local.Command('agentlayer-docs-invalidation', {
	create: pulumi.interpolate`aws cloudfront create-invalidation --distribution-id ${distribution.id} --paths "/*"`,
	triggers: [docsBuild.stdout],
})

export const siteUrl = pulumi.interpolate`https://agentlayer.${domainSuffix}`
export const distributionId = distribution.id
